'use strict';

/**
 * Système NV11 + Smart Hopper - Raspberry Pi 5
 * Compatible Node.js 20+ et serialport@10+
 *
 * === CORRECTIFS APPLIQUÉS (voir résumé livré avec ce fichier) ===
 */

require('dotenv').config();

const express = require('express');
const { SerialPort } = require('serialport');
const sspLib = require('@tidemx/encrypted-smiley-secure-protocol'); // ou node-NV11 si tu préfères
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();
app.use(express.json());

const winston = require('winston');
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${extra}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/app.log' }),
    new winston.transports.Console()
  ]
});

logger.info('Serveur démarré');

// === Configuration générale ===
const NV11_PORT = process.env.NV11_PORT || '/dev/ttyACM0';
const HOPPER_PORT = process.env.HOPPER_PORT || '/dev/ttyUSB0';
const SERVER_URL = process.env.SERVER_URL || 'http://smartcoins.local/api/cash/endpoint';
const SERVER_URL_HOPPER = process.env.SERVER_URL_HOPPER || 'http://smartcoins.local/api/cash/get-levels';
const SERVER_URL_NV11 = process.env.SERVER_URL_NV11 || 'http://smartcoins.local/api/cash/slot-status';

// CORRECTIF SECURITE : le token ne doit plus être écrit en dur.
// Définis AUTH_TOKEN dans un fichier .env (non versionné) : AUTH_TOKEN=xxxx
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
  logger.error('AUTH_TOKEN manquant : définis-le dans le fichier .env avant de démarrer le serveur.');
  process.exit(1);
}

const EMAIL_TO = process.env.EMAIL_TO || 'legrandse@gmail.com';

const NOTE_VALUES = { 1: 5, 2: 10, 3: 20, 4: 50, 5: 100, 6: 200, 7: 500 };
const MAX_SLOTS = 30;

// === Variables d'état ===
let isStacking = false;
let noteInProcessing = false;
let transactionId = 0;
let amountValue = null;
let isPayoutInProgress = false;
let totalPaid = 0;
let lastRendu = 0;
let lastCommand = null; // CORRECTIF : déclarée explicitement (était une globale implicite)

// === Création des instances NV11 ===
const NV11 = new sspLib({
  id: 0,
  debug: false,
  timeout: 3000,
  fixedKey: '0123456701234567',
  port: NV11_PORT,
});

const Hopper = new sspLib({
  id: 16,
  debug: true,
  timeout: 5000,
  fixedKey: '0123456701234567',
  port: HOPPER_PORT,
});

// === NV11 ===
NV11.on('OPEN', async () => {
  console.log(`✅ NV11 connecté (${NV11_PORT})`);
  try {
    await NV11.command('SYNC');
    await NV11.command('HOST_PROTOCOL_VERSION', { version: 6 });
    await NV11.initEncryption();
    const serial = await NV11.command('GET_SERIAL_NUMBER');
    console.log('NV11 Serial:', serial.info.serial_number);
    await NV11.command('SET_CHANNEL_INHIBITS', { channels: [1, 1, 1, 1, 0, 0, 0, 0] });
    await NV11.command('SET_DENOMINATION_ROUTE', { route: 'payout', value: 1000, country_code: 'EUR' });
    await NV11.command('ENABLE_PAYOUT_DEVICE', {
      GIVE_VALUE_ON_STORED: true,
      NO_HOLD_NOTE_ON_PAYOUT: false,
    });
    await checkNoteSlotsStatus();

    await NV11.disable();
    console.log('✅ NV11 prêt');
  } catch (err) {
    console.error('❌ Erreur NV11:', err.message);
    logger.error(`Erreur init NV11: ${err.message}`);
  }
});

// === Smart Hopper ===
Hopper.on('OPEN', async () => {
  console.log(`✅ Smart Hopper connecté (${HOPPER_PORT})`);
  try {
    await Hopper.command('SYNC');
    await Hopper.command('HOST_PROTOCOL_VERSION', { version: 6 });
    const setup = await Hopper.command('SETUP_REQUEST');
    console.log('Protocol version:', setup.info.protocol_version);
    await Hopper.initEncryption();
    await Hopper.command('COIN_MECH_OPTIONS', { ccTalk: false });
    await Hopper.command('SET_COIN_MECH_GLOBAL_INHIBIT', { enable: true });

    await Hopper.command('SET_HOPPER_OPTIONS', {
      payMode: false,
      levelCheck: true,
      motorSpeed: false,
      cashBoxPayActive: false,
      route0LevelToCashbox: false,
      highEfficiencySplit: false,
      unknownToPayout: false,
      valueAddedEvent: true // false = COIN_CREDIT (0xDF)
    });

    // --- Récupération des niveaux ---
    const levels = await Hopper.command('GET_ALL_LEVELS');

    // --- Envoi au serveur ---
    await postWithRetry({
      status: {
        message: `Stored levels: ${JSON.stringify(levels.info.counter)}`,
        value: 'info'
      }
    }, SERVER_URL_HOPPER).catch(error => {
      console.error(`Erreur lors de l'envoi: ${error.message}`);
    });

    await Hopper.disable();
    console.log('✅ Hopper prêt');
  } catch (err) {
    console.error('❌ Erreur Hopper:', err.message);
    logger.error(`Erreur init Hopper: ${err.message}`);
  }
});

// Gestionnaires d'événements supplémentaires
NV11.on('NOTE_REJECTED', () => {
  const data = { status: { message: 'Note rejected', value: 'warning' } };
  noteInProcessing = false;
  NV11.command('LAST_REJECT_CODE').then(rejectResult => {
    console.log('Resultat de LAST_REJECT_CODE:', rejectResult);
    data.status.message = rejectResult.info.description;
    postWithRetry(data, SERVER_URL)
      .catch(error => {
        console.error(`Erreur lors de l'envoi: ${data.status.message} (${error.message})`);
      });
  }).catch(err => {
    console.error('Erreur lors de la récupération du code de rejet: ', err);
  });
});

NV11.on('STACKER_FULL', result => {
  const data = { status: { message: `${result.info.description}`, value: 'error' } };
  noteInProcessing = false;
  postWithRetry(data, SERVER_URL)
    .catch(error => {
      console.error(`Erreur lors de l'envoi: ${data.status.message} (${error.message})`);
    });
});

NV11.on('CASHBOX_REMOVED', result => {
  const data = { status: { message: `${result.info.description}`, value: 'error' } };
  noteInProcessing = false;
  postWithRetry(data, SERVER_URL)
    .catch(error => {
      console.error(`Erreur lors de l'envoi: ${data.status.message} (${error.message})`);
    });
});

NV11.on('UNSAFE_NOTE_JAM', result => {
  const data = { status: { message: `${result.info.description}`, value: 'error' } };
  noteInProcessing = false;
  postWithRetry(data, SERVER_URL)
    .catch(error => {
      console.error(`Erreur lors de l'envoi: ${data.status.message} (${error.message})`);
    });
});

NV11.on('READ_NOTE', () => {
  if (!noteInProcessing) {
    noteInProcessing = true;
    postWithRetry({ status: { message: 'Traitement du billet en cours...', value: 'process' } }, SERVER_URL)
      .then(() => console.log("Data successfully sent for 'Note in processing'"))
      .catch(error => console.error(`Final failure to send 'Note in processing' data: ${error.message}`));
  }
});

NV11.on('DISPENSING', result => {
  if (!noteInProcessing) {
    noteInProcessing = true;
    logger.info('DISPENSING event data', { result });
    postWithRetry({ status: { message: 'Rendu de monnaie en cours...', value: 'process' } }, SERVER_URL)
      .then(() => console.log("Data successfully sent for 'Note in processing'"))
      .catch(error => console.error(`Final failure to send 'Note in processing' data: ${error.message}`));
  }
});

// === Gestion d'un billet inséré (CREDIT_NOTE) ===
NV11.on('CREDIT_NOTE', result => {
  if (isStacking) {
    checkNoteSlotsStatus()
      .then(({ usedSlotCount, remainingSlots }) => {
        console.log(`Slots: utilisés=${usedSlotCount}, restants=${remainingSlots}`);
      })
      .catch((error) => {
        console.error(`Final failure: ${error.message}`);
      });

    console.log('⚠️ CREDIT_NOTE ignoré car séquence STACK en cours');
    return;
  }

  const processCreditNote = async () => {
    try {
      const noteId = result.channel;
      if (!NOTE_VALUES[noteId]) {
        console.log(`❓ Billet inconnu, channel=${noteId}`);
        return;
      }

      // CORRECTIF : on ignore le crédit si aucune transaction n'est active,
      // pour éviter un rendu de monnaie déclenché par erreur (amountValue null → coercion à 0).
      if (amountValue === null) {
        console.warn('⚠️ Billet inséré hors transaction (amountValue non défini) — ignoré.');
        logger.error('Billet inséré hors transaction active');
        return;
      }

      const noteValue = NOTE_VALUES[noteId];
      noteInProcessing = false;

      totalPaid += noteValue;
      console.log(`💵 Billet inséré: ${noteValue}€ | Total payé: ${totalPaid}€ / dû: ${amountValue}€`);
      logger.info(`Billet inséré: ${noteValue}€ | Total payé: ${totalPaid}€ / dû: ${amountValue}€`);

      await postWithRetry({ status: { transaction: transactionId, note: noteValue, value: 'credited' } }, SERVER_URL);

      const { usedSlotCount, remainingSlots } = await checkNoteSlotsStatus();
      console.log(`Slots NV11: utilisés=${usedSlotCount}, restants=${remainingSlots}`);

      await maybeTriggerRendu();
    } catch (error) {
      console.error(`❌ Erreur processCreditNote: ${error.message}`);
      logger.error(`Erreur processCreditNote: ${error.message}`);
    }
  };

  processCreditNote();
});

// SMART HOPPER Function
function handleCoinInserted(amount, currency) {
  console.log(`💰 Traitement pièce: ${amount} ${currency}`);
  logger.info(`Traitement pièce: ${amount} ${currency}`);
  postWithRetry({
    status: {
      transaction: transactionId,
      note: amount,
      value: 'credited',
    }
  }, SERVER_URL).catch(error => {
    console.error(`Erreur envoi: ${error.message}`);
  });
}

// === Gestion d'une pièce insérée ===
Hopper.on('COIN_CREDIT', async (event) => {
  try {
    if (!event.value || !Array.isArray(event.value)) {
      console.warn('❌ Format inattendu de COIN_CREDIT:', event);
      return;
    }

    // CORRECTIF : même garde-fou que pour les billets.
    if (amountValue === null) {
      console.warn('⚠️ Pièce insérée hors transaction (amountValue non défini) — ignorée.');
      logger.error('Pièce insérée hors transaction active');
      return;
    }

    for (const coin of event.value) {
      const amount = coin.value / 100; // conversion centimes → euros
      const currency = coin.country_code || 'EUR';

      console.log(`🪙 Pièce détectée: ${amount.toFixed(2)} ${currency}`);
      logger.info(`Pièce détectée: ${amount.toFixed(2)} ${currency}`);
      handleCoinInserted(amount, currency);

      totalPaid += amount;
      console.log(`💰 Total payé: ${totalPaid.toFixed(2)}€ / dû: ${amountValue}€`);
      logger.info(`Total payé: ${totalPaid.toFixed(2)}€ / dû: ${amountValue}€`);

      await maybeTriggerRendu();
    }
  } catch (error) {
    console.error('❌ Erreur COIN_CREDIT:', error.message);
    logger.error(`Erreur COIN_CREDIT: ${error.message}`);
  }
});

Hopper.on('DISPENSING', result => {
  if (!noteInProcessing) {
    noteInProcessing = true;
    logger.info('DISPENSING event data (Hopper)', { result });
    postWithRetry({ status: { message: 'Rendu de monnaie en cours...', value: 'process' } }, SERVER_URL)
      .then(() => console.log("Data successfully sent for 'Note in processing'"))
      .catch(error => console.error(`Final failure to send 'Note in processing' data: ${error.message}`));
  }
});

/**
 * CORRECTIF : centralise la vérification "montant atteint" utilisée à la fois
 * par CREDIT_NOTE et COIN_CREDIT, avec garde contre amountValue null/0 et contre
 * un déclenchement en double si un rendu est déjà en cours.
 */
async function maybeTriggerRendu() {
  if (amountValue === null) return;
  if (totalPaid < amountValue) return;
  if (isPayoutInProgress) {
    console.warn('⚠️ Montant atteint mais un rendu est déjà en cours, on attend.');
    return;
  }

  const rendu = +(totalPaid - amountValue).toFixed(2);

  if (rendu > 0) {
    console.log(`💶 Rendu à effectuer: ${rendu}€`);
    logger.info(`Rendu à effectuer: ${rendu}€`);
    await handleRenduMixte(rendu);
  } else {
    console.log('✅ Paiement exact, aucun rendu.');
    logger.info('Paiement exact, aucun rendu.');
    resetTransaction();
  }
}

// Ouverture de la connexion au validateur
NV11.open(NV11_PORT);
Hopper.open(HOPPER_PORT);

/**
 * Fonction pour faire une requête POST avec retry et timeout
 */
function postWithRetry(data, url, retries = 1, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const attemptPost = (retryCount) => {
      axios.post(url, data, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        timeout: timeout
      })
        .then(response => {
          console.log(`Sent data to server: ${data.status.message}, response: ${response.status}`);
          resolve(response);
        })
        .catch(error => {
          if (retryCount > 0) {
            console.warn(`Retrying... Attempts left: ${retryCount}. Error: ${error.message}`);
            setTimeout(() => attemptPost(retryCount - 1), 1000);
          } else {
            console.error(`Failed after ${retries} attempts: ${error.message}`);
            reject(error);
          }
        });
    };
    attemptPost(retries);
  });
}

// Middleware pour vérifier le token Bearer
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token not provided' });
  if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'Invalid token' });
  next();
}

async function checkNoteSlotsStatus() {
  try {
    const resultSlots = await NV11.command('GET_NOTE_POSITIONS');

    // CORRECTIF : vérification défensive de la structure (comme pour COIN_CREDIT)
    const slots = resultSlots && resultSlots.info && resultSlots.info.slot;
    if (!slots || typeof slots !== 'object') {
      console.warn('⚠️ Format inattendu pour GET_NOTE_POSITIONS:', resultSlots);
      return { usedSlotCount: null, remainingSlots: null };
    }

    const usedSlotCount = Object.keys(slots).length;
    const remainingSlots = MAX_SLOTS - usedSlotCount;

    console.log(`🔍 ${remainingSlots} positions libres (sur ${MAX_SLOTS})`);

    await sendSlotStatusToLaravel(usedSlotCount, remainingSlots, remainingSlots >= 26);

    return { usedSlotCount, remainingSlots };
  } catch (error) {
    console.error(`Erreur lors de la vérification des slots : ${error.message}`);
    return { usedSlotCount: null, remainingSlots: null };
  }
}

/**
 * Calcule la répartition du rendu entre billets et pièces
 * @param {number} montant - Montant total à rendre en euros
 * @returns {Object} { billets10, reste }
 */
function calculerRenduMixte(montant) {
  const billets10 = Math.floor(montant / 10);
  const reste = +(montant % 10).toFixed(2);
  return { billets10, reste };
}

/**
 * Rend `count` billets de 10€ via le NV11 et résout une fois le rendu terminé
 * (ou rejette en cas d'échec). CORRECTIF : transformé en Promise pour pouvoir
 * être awaité par handleRenduMixte au lieu de tourner en tâche de fond isolée.
 */
function handlePayoutRequest(count) {
  return new Promise((resolve, reject) => {
    let dispensed = 0;

    // CORRECTIF : PAYOUT_NOTE peut être ACQUITTÉ par le NV11 avec `success: false`
    // (ex. errorCode 3 "Note float busy" quand le float interne est encore occupé à
    // ranger un billet qu'on vient d'insérer). Ce n'est PAS un rejet de promesse —
    // sans vérifier result.success, on attendait en vain un DISPENSED qui n'arrive
    // jamais, jusqu'au timeout de 30s. On retente maintenant sur les erreurs transitoires
    // connues, avant d'abandonner.
    const RETRYABLE_ERROR_CODES = new Set([3]); // 3 = Note float busy
    const MAX_PAYOUT_RETRIES = 6;
    const PAYOUT_RETRY_DELAY_MS = 1500; // 6 x 1.5s = 9s de marge, largement sous les 30s du failsafe

    const cleanup = () => {
      NV11.off('DISPENSED', onDispensed);
      clearTimeout(failsafeTimer);
    };

    function sendPayoutNote(attempt = 1) {
      NV11.command('PAYOUT_NOTE')
        .then((result) => {
          if (result && result.success === false) {
            const errorCode = result.info && result.info.errorCode;
            const errorDesc = (result.info && result.info.error) || result.status;
            const retryable = RETRYABLE_ERROR_CODES.has(errorCode);

            if (retryable && attempt < MAX_PAYOUT_RETRIES) {
              console.warn(`⚠️ PAYOUT_NOTE refusée (${errorDesc}), retry ${attempt}/${MAX_PAYOUT_RETRIES} dans ${PAYOUT_RETRY_DELAY_MS}ms`);
              logger.error(`PAYOUT_NOTE refusée (${errorDesc}), retry ${attempt}/${MAX_PAYOUT_RETRIES}`);
              setTimeout(() => sendPayoutNote(attempt + 1), PAYOUT_RETRY_DELAY_MS);
              return;
            }

            console.error(`❌ PAYOUT_NOTE définitivement refusée après ${attempt} tentative(s):`, result);
            logger.error(`PAYOUT_NOTE définitivement refusée après ${attempt} tentative(s): ${errorDesc}`);
            cleanup();
            reject(new Error(`PAYOUT_NOTE refusée: ${errorDesc}`));
            return;
          }

          console.log(`✅ PAYOUT_NOTE acquittée par le NV11 (tentative ${attempt}):`, result);
          logger.info('PAYOUT_NOTE acquittée par le NV11', { attempt, result });
        })
        .catch(err => {
          console.error('Erreur lors de PAYOUT_NOTE:', err.message);
          logger.error(`Erreur lors de PAYOUT_NOTE: ${err.message}`);
          cleanup();
          reject(err);
        });
    }

    const onDispensed = () => {
      dispensed++;
      console.log(`✅ Note ${dispensed}/${count} dispensed`);
      logger.info(`Note ${dispensed}/${count} dispensed`);

      postWithRetry({ status: { transaction: transactionId, note: 10, value: 'debited' } }, SERVER_URL)
        .then(() => console.log('📨 Débit enregistré dans le serveur'))
        .catch((err) => console.error(`⚠️ Échec de l'envoi du débit: ${err.message}`));

      if (dispensed >= count) {
        cleanup();
        NV11.disable()
          .then(() => {
            console.log('✅ Payout terminé. Validator désactivé');
            logger.info('Payout terminé. Validator désactivé');
            resolve();
          })
          .catch((err) => {
            console.error(err);
            reject(err);
          });
        return;
      }

      // Attendre 1 seconde avant la prochaine commande (billet suivant)
      setTimeout(() => sendPayoutNote(1), 1000);
    };

    NV11.off('DISPENSED', onDispensed); // s'assurer qu'aucun ancien listener ne traîne
    NV11.on('DISPENSED', onDispensed);

    NV11.enable()
      .then(() => NV11.command('ENABLE_PAYOUT_DEVICE', {
        GIVE_VALUE_ON_STORED: true,
        NO_HOLD_NOTE_ON_PAYOUT: false,
      }))
      .then(() => {
        console.log(`⏳ Début du rendu de ${count} billet(s)...`);
        logger.info(`Début du rendu de ${count} billet(s)...`);
        sendPayoutNote(1); // premier billet
      })
      .catch(err => {
        console.error('Erreur lors du payout initial:', err);
        logger.error(`Erreur lors du payout initial: ${err.message}`);
        cleanup();
        reject(err);
      });

    // Failsafe timeout
    const failsafeTimer = setTimeout(() => {
      NV11.off('DISPENSED', onDispensed);
      checkNoteSlotsStatus();
      console.warn('⏱ Listener DISPENSED retiré après timeout (failsafe)');
      logger.error(`Timeout du rendu billets (failsafe) après ${count * 30000}ms, dispensed=${dispensed}/${count}`);
      reject(new Error('Timeout du rendu billets (failsafe)'));
    }, count * 30000);
  });
}

/**
 * Gère le rendu via NV11 (billets) + Hopper (pièces).
 * CORRECTIF : les deux rendus sont maintenant réellement attendus (Promise.allSettled)
 * avant de réinitialiser l'état de transaction, et isPayoutInProgress est remis à false
 * dans un `finally` quoi qu'il arrive.
 */
async function handleRenduMixte(rendu) {
  const { billets10, reste } = calculerRenduMixte(rendu);
  console.log(`💶 Rendu total ${rendu}€ -> ${billets10}x10€ + ${reste}€ en pièces`);
  logger.info(`Rendu total ${rendu}€ -> ${billets10}x10€ + ${reste}€ en pièces`);

  isPayoutInProgress = true;
  lastRendu = rendu;

  const tasks = [];

  // === 1️⃣ Rendu billets ===
  if (billets10 > 0) {
    tasks.push(handlePayoutRequest(billets10));
  }

  // === 2️⃣ Rendu pièces ===
  if (reste > 0) {
    const hopperAmount = Math.round(reste * 100);
    console.log(`🪙 Hopper : rendu ${reste}€ (${hopperAmount} cts) en pièces...`);
    logger.info(`Hopper : rendu ${reste}€ (${hopperAmount} cts) en pièces...`);

    const dispensePromise = new Promise((resolve, reject) => {
      const onDispensed = async (data) => {
        console.log(`✅ Event DISPENSED reçu: ${JSON.stringify(data)}`);
        logger.info('Event DISPENSED reçu (Hopper)', { data });
        Hopper.off('DISPENSED', onDispensed);
        Hopper.off('ERROR', onError);

        // Le rendu de pièces est déjà terminé à ce stade : tout ce qui suit
        // (statut de débit, lecture des niveaux) est un best-effort de reporting.
        // Un échec ici ne doit JAMAIS faire échouer la transaction, ni pire,
        // planter en unhandledRejection au niveau du parseur SSP.
        try {
          await postWithRetry(
            { status: { transaction: transactionId, note: reste, value: 'debited' } },
            SERVER_URL
          );
          console.log('📨 Statut de débit envoyé à Laravel');
        } catch (err) {
          console.error('⚠️ Échec envoi statut de débit:', err.message);
          logger.error(`Échec envoi statut de débit: ${err.message}`);
        }

        // CORRECTIF : GET_ALL_LEVELS juste après un DISPENSED provoque parfois un
        // RangeError [ERR_BUFFER_OUT_OF_BOUNDS] dans le parseur interne de la lib SSP
        // (paquet renvoyé trop court car le Hopper finit encore sa transition d'état).
        // On laisse un court délai, et on isole l'appel : son échec ne bloque plus
        // la résolution du rendu de monnaie, qui est déjà acquis à ce stade.
        try {
          await new Promise(r => setTimeout(r, 400));
          const levels = await Hopper.command('GET_ALL_LEVELS');
          console.log('📊 Niveaux Hopper après rendu:', levels.info.counter);

          await postWithRetry(
            {
              status: {
                message: `Stored levels: ${JSON.stringify(levels.info.counter)}`,
                value: 'info',
              },
            },
            SERVER_URL_HOPPER
          );
          console.log('📊 Niveaux Hopper envoyés au serveur secondaire');
        } catch (err) {
          console.error('⚠️ Lecture des niveaux Hopper après rendu échouée (non bloquant):', err.message);
          logger.error(`Lecture des niveaux Hopper échouée après rendu (non bloquant): ${err.message}`);
        }

        resolve();
      };

      const onError = (err) => {
        Hopper.off('DISPENSED', onDispensed);
        Hopper.off('ERROR', onError);
        console.error('❌ Erreur Hopper pendant PAYOUT:', err.message);
        logger.error(`Erreur Hopper pendant PAYOUT: ${err.message}`);
        reject(err);
      };

      Hopper.on('DISPENSED', onDispensed);
      Hopper.on('ERROR', onError);
    });

    tasks.push(
      Hopper.command('PAYOUT_AMOUNT', {
        amount: hopperAmount,
        country_code: 'EUR',
        test: false,
      }).then(() => dispensePromise)
    );
  }

  try {
    // CORRECTIF : allSettled plutôt que de laisser le rendu billets en tâche
    // de fond non suivie — on attend la fin réelle des deux rendus.
    const results = await Promise.allSettled(tasks);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      failed.forEach(f => console.error('❌ Une partie du rendu a échoué:', f.reason && f.reason.message));
      logger.error(`Rendu partiellement échoué: ${failed.map(f => f.reason && f.reason.message).join(' | ')}`);
      await postWithRetry(
        { status: { transaction: transactionId, message: 'Échec partiel du rendu de monnaie', value: 'error' } },
        SERVER_URL
      ).catch(() => {});
    } else {
      console.log('🎉 Rendu mixte terminé');
      logger.info('Rendu mixte terminé');
    }
  } finally {
    // CORRECTIF : on ne laisse plus isPayoutInProgress bloqué à true indéfiniment.
    resetTransaction();
  }
}

async function sendSlotStatusToLaravel(used, remaining, alertSent) {
  try {
    const response = await axios.post(SERVER_URL_NV11, {
      used_slots: used,
      remaining_slots: remaining,
      alert_sent: alertSent,
    }, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 5000,
    });
    console.log('✅ Enregistré dans Laravel :', response.data && response.data.message);
  } catch (error) {
    console.error("❌ Erreur lors de l'envoi à Laravel :", error.message);
  }
}

/**
 * CORRECTIF : c'est désormais la seule fonction qui remet l'état à zéro
 * (au lieu du reset inline dupliqué dans processCreditNote/COIN_CREDIT/handleRenduMixte).
 */
function resetTransaction() {
  totalPaid = 0;
  amountValue = null;
  isPayoutInProgress = false;
  noteInProcessing = false;
}

// === API routes ===
app.post('/enable', authenticateToken, async (req, res) => {
  try {
    const { amount, stacking, transaction_id } = req.body;

    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: 'amount manquant' });
    }

    amountValue = Number(parseFloat(String(amount).replace(',', '.')).toFixed(2));
    if (Number.isNaN(amountValue)) {
      amountValue = null;
      return res.status(400).json({ error: 'amount invalide' });
    }

    transactionId = transaction_id;
    totalPaid = 0;
    noteInProcessing = false;
    isStacking = !!stacking;

    // CORRECTIF : les deux activations sont attendues et gérées via Promise.allSettled
    // pour éviter un rejet non catché (Hopper.enable() plantait le process sur Node 20).
    const [nv11Result, hopperResult] = await Promise.allSettled([
      NV11.enable(),
      Hopper.enable(),
    ]);

    if (nv11Result.status === 'rejected') {
      console.error('❌ Erreur activation NV11:', nv11Result.reason);
      return res.status(500).json({ error: 'Failed to enable NV11', details: nv11Result.reason && nv11Result.reason.message });
    }
    if (hopperResult.status === 'rejected') {
      console.error('❌ Erreur activation Hopper:', hopperResult.reason);
      // On continue quand même : le NV11 est actif, mais on informe le client.
    }

    logger.info('Lecteurs activés');
    res.json({
      status: 'Readers enabled',
      nv11: nv11Result.value,
      hopper: hopperResult.status === 'fulfilled' ? hopperResult.value : { error: hopperResult.reason && hopperResult.reason.message }
    });
  } catch (error) {
    console.error('❌ Erreur /enable:', error);
    res.status(500).json({ error: 'Failed to enable readers', details: error.message });
  }
});

app.post('/disable', authenticateToken, async (req, res) => {
  try {
    const [nv11Result, hopperResult] = await Promise.allSettled([
      NV11.disable(),
      Hopper.disable()
    ]);

    logger.info('Lecteurs désactivés');
    res.json({
      status: 'Both readers disabled',
      nv11: nv11Result.status === 'fulfilled' ? nv11Result.value : { error: nv11Result.reason && nv11Result.reason.message },
      hopper: hopperResult.status === 'fulfilled' ? hopperResult.value : { error: hopperResult.reason && hopperResult.reason.message }
    });
  } catch (error) {
    console.error('❌ Erreur lors de la désactivation:', error);
    res.status(500).json({ error: 'Failed to disable devices', details: error.message });
  }
});

app.post('/collect', authenticateToken, async (req, res) => {
  try {
    lastCommand = 'SMART_EMPTY';
    await NV11.enable();
    await new Promise(r => setTimeout(r, 500));

    console.log('➡️ Envoi SMART_EMPTY...');
    const emptyResult = await NV11.command('SMART_EMPTY');

    res.json({
      status: 'Cashbox emptied successfully',
      result: emptyResult,
    });
  } catch (error) {
    console.error('❌ Collect error:', error);
    res.status(500).json({
      error: 'Failed to process cashbox collection',
      details: error.message
    });
  } finally {
    lastCommand = null;
    try {
      const { usedSlotCount, remainingSlots } = await checkNoteSlotsStatus();
      console.log(`📊 Slots après collect: utilisés=${usedSlotCount}, restants=${remainingSlots}`);
    } catch (err) {
      console.error(`⚠️ Impossible de lire l'état des slots: ${err.message}`);
    }
  }
});

app.post('/collectHopper', authenticateToken, async (req, res) => {
  try {
    lastCommand = 'SMART_EMPTY';
    await Hopper.enable();
    await new Promise(r => setTimeout(r, 500));

    console.log('➡️ Envoi SMART_EMPTY...');
    const emptyResult = await Hopper.command('SMART_EMPTY');

    res.json({
      status: 'Cashbox emptied successfully',
      result: emptyResult,
    });
  } catch (error) {
    console.error('❌ Collect error:', error);
    res.status(500).json({
      error: 'Failed to process cashbox collection',
      details: error.message
    });
  } finally {
    lastCommand = null;
    try {
      const { usedSlotCount, remainingSlots } = await checkNoteSlotsStatus();
      console.log(`📊 Coins après collect: utilisés=${usedSlotCount}, restants=${remainingSlots}`);
    } catch (err) {
      console.error(`⚠️ Impossible de lire l'état des slots: ${err.message}`);
    }
  }
});

app.post('/hopperStack', authenticateToken, async (req, res) => {
  const { amount, denomination } = req.body;
  console.log('✅ Denomination:', denomination);

  try {
    const quantity = amount;

    await Hopper.enable();

    await Hopper.command('SET_DENOMINATION_LEVEL', {
      value: quantity,
      denomination: parseFloat(denomination) * 100,
      country_code: 'EUR'
    });

    const levels = await Hopper.command('GET_ALL_LEVELS');
    console.log('📊 Tous les niveaux mis à jour:', levels);

    await postWithRetry({
      status: {
        message: `Stored levels: ${JSON.stringify(levels.info.counter)}`,
        value: 'info'
      }
    }, SERVER_URL_HOPPER).catch(error => {
      console.error(`❌ Erreur lors de l'envoi au serveur central: ${error.message}`);
    });

    res.status(200).json({
      status: 'success',
      message: 'Hopper configuration updated and synced successfully',
      levels
    });
  } catch (error) {
    console.error('❌ Erreur globale /hopperStack:', error);
    res.status(500).json({
      error: 'Failed to update hopper levels',
      details: error.message
    });
  }
});

app.post('/stack', authenticateToken, async (req, res) => {
  try {
    // CORRECTIF : /stack n'activait jamais isStacking, donc les billets insérés
    // tombaient dans processCreditNote() au lieu d'être juste empilés — et s'y
    // faisaient bloquer par le garde-fou "amountValue === null" (transaction absente).
    isStacking = true;
    noteInProcessing = false;
    await NV11.enable();
    logger.info('Mode empilage (stack) activé');
    res.json({ status: 'Waiting for stacking notes' });
  } catch (error) {
    console.error('❌ Collect error:', error);
    res.status(500).json({
      error: 'Failed to process cashbox collection',
      details: error.message
    });
  }
});

app.post('/cancel', authenticateToken, async (req, res) => {
  const { amount, transaction_id } = req.body;
  transactionId = transaction_id;

  // CORRECTIF : on active les lecteurs et on vérifie le résultat AVANT
  // d'envoyer la réponse HTTP, pour ne plus risquer un double envoi
  // (res.json() puis res.status(500).json() sur la même requête).
  try {
    const [nv11Result, hopperResult] = await Promise.allSettled([
      NV11.enable(),
      Hopper.enable(),
    ]);

    if (nv11Result.status === 'rejected' && hopperResult.status === 'rejected') {
      throw new Error("NV11 et Hopper ont échoué à s'activer");
    }

    res.json({
      status: 'processing',
      message: 'Refund started'
    });

    const parsedAmount = Number(parseFloat(String(amount).replace(',', '.')).toFixed(2));
    if (!Number.isNaN(parsedAmount) && parsedAmount > 0) {
      handleRenduMixte(parsedAmount).catch(err => {
        console.error('❌ Erreur rendu:', err);
        logger.error(`Erreur rendu (cancel): ${err.message}`);
      });
    } else {
      console.warn('⚠️ /cancel appelé avec un montant invalide:', amount);
    }
  } catch (error) {
    console.error('❌ Cancel error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to process refund',
        details: error.message
      });
    }
  }
});

app.post('/reset', authenticateToken, async (req, res) => {
  // CORRECTIF : l'ancien code réaffectait `NV11` (déclarée en `const`, donc
  // TypeError) et appelait `initializeValidator`/`COM_PORT`, deux identifiants
  // inexistants dans ce fichier. On se contente d'envoyer RESET et de laisser
  // l'appareil se reconnecter tout seul (il ré-émettra 'OPEN').
  console.log('Attempting to reset the validator...');
  try {
    const result = await NV11.command('RESET');
    console.log('Validator reset command sent successfully.', result);
    logger.info('Validator reset command sent');
    resetTransaction();
    res.json({ status: 'Validator reset', result });
  } catch (error) {
    console.error('Failed to reset validator:', error);
    res.status(500).json({ error: 'Failed to reset validator', details: error.message });
  }
});

process.on('SIGINT', async () => {
  console.log('\n🧹 Fermeture propre...');
  logger.info('Fermeture propre...');
  try {
    await NV11.disable();
    await Hopper.disable();
  } catch (err) {
    console.warn('Erreur lors de la désactivation :', err.message);
  } finally {
    NV11.close();
    Hopper.close();
    process.exit(0);
  }
});

// CORRECTIF : filet de sécurité global — logue au lieu de laisser
// Node tuer silencieusement le process sur une promesse non gérée oubliée ailleurs.
process.on('unhandledRejection', (reason) => {
  console.error('🚨 Unhandled Rejection:', reason);
  logger.error(`Unhandled Rejection: ${reason && reason.message ? reason.message : reason}`);

  // Cas connu : un paquet trop court fait planter le parseur SSP interne
  // (@tidemx/encrypted-smiley-secure-protocol) hors de toute Promise qu'on contrôle.
  // Après ça, le POLL se met souvent à timeouter en boucle (protocole désynchronisé).
  // On tente une resynchronisation best-effort plutôt que de laisser la boucle de
  // TIMEOUT tourner indéfiniment.
  if (reason && reason.code === 'ERR_BUFFER_OUT_OF_BOUNDS') {
    console.warn('🔄 Tentative de resynchronisation SSP (Hopper) après erreur de parsing...');
    logger.error('Tentative de resynchronisation SSP (Hopper) après ERR_BUFFER_OUT_OF_BOUNDS');
    Hopper.command('SYNC')
      .then(() => console.log('✅ Resynchronisation Hopper OK'))
      .catch((err) => console.error('❌ Resynchronisation Hopper échouée:', err.message));
  }
});

// === Lancement du serveur HTTP ===
app.listen(8002, () => {
  console.log('🚀 Serveur NV11 démarré sur le port 8002');
});
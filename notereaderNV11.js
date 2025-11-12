/**
 * Système NV11 + Smart Hopper - Raspberry Pi 5
 * Compatible Node.js 20+ et serialport@10+
 */

const express = require('express');
const { SerialPort } = require('serialport');
const sspLib = require('@tidemx/encrypted-smiley-secure-protocol'); // ou node-NV11 si tu préfères
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// === Configuration générale ===
const NV11_PORT = '/dev/ttyACM0';
const HOPPER_PORT = '/dev/ttyUSB0';
//const SERVER_URL = 'http://smartcoins.local/cash/endpoint';
const SERVER_URL = 'https://smartcoins.ngrok.app/cash/endpoint';
const SERVER_URL_HOPPER = 'https://smartcoins.ngrok.app/cash/get-levels';
const SERVER_URL_NV11 = 'https://smartcoins.ngrok.app/cash/slot-status';
const AUTH_TOKEN = '4GH59FD3KG9rtgijeoitvCE3440sllg';
const EMAIL_TO = 'legrandse@gmail.com';

const NOTE_VALUES = { 1: 5, 2: 10, 3: 20, 4: 50, 5: 100, 6: 200, 7: 500 };

// === Variables d’état ===
let isStacking = false;
let noteInProcessing = false;
let amountValue = null;
let isPayoutInProgress = false;
let totalPaid = 0;


// === Initialisation des ports ===
//const nv11Serial = new SerialPort({ path: NV11_PORT, baudRate: 9600 });
//const hopperSerial = new SerialPort({ path: HOPPER_PORT, baudRate: 9600 });

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
    await NV11.command('SET_DENOMINATION_ROUTE', { route:'payout', value:1000, country_code:'EUR' });
    await NV11.command('ENABLE_PAYOUT_DEVICE', { 
      GIVE_VALUE_ON_STORED: true,
      NO_HOLD_NOTE_ON_PAYOUT: false, });
    const resultSlots = await NV11.command('GET_NOTE_POSITIONS');
      console.log('📦 Résultat brut GET_NOTE_POSITIONS:', JSON.stringify(resultSlots, null, 2));
      const slots = resultSlots.info.slot;
    // --- Envoi au serveur ---
    await postWithRetry({
      status: {
        message: `Stored levels: ${JSON.stringify(resultSlots, null, 2)}`,
        value: 'info'
      }
    }, SERVER_URL_NV11).catch(error => {
      console.error(`Erreur lors de l'envoi: ${error.message}`);
    });
    await NV11.disable();
    console.log('✅ NV11 prêt');
  } catch (err) {
    console.error('❌ Erreur NV11:', err.message);
  }
});

// === Smart Hopper ===
Hopper.on('OPEN', async () => {
  console.log(`✅ Smart Hopper connecté (${HOPPER_PORT})`);
  try {
    await Hopper.command('SYNC');
    await Hopper.command('HOST_PROTOCOL_VERSION', { version: 6 });
    await Hopper.initEncryption();
    await Hopper.command('COIN_MECH_OPTIONS', { ccTalk: false });
    await Hopper.command('SET_COIN_MECH_GLOBAL_INHIBIT', { enable: true });

    // --- Récupération des niveaux ---
    const levels = await Hopper.command('GET_ALL_LEVELS');

    // --- Log détaillé ---
  /*console.log('📊 Niveaux actuels du Hopper :');
    if (levels?.info?.counter) {
      const counters = levels.info.counter;
      Object.entries(counters).forEach(([key, data]) => {
        const value = (data.value / 100).toFixed(2); // pour l’afficher en euros
        const level = data.denomination_level;
        const country = data.country_code || 'N/A';
        console.log(`  → Canal ${key}: ${value} ${country}, niveau = ${level}`);
      });
    } else {
      console.log('  ⚠️ Format inattendu pour les niveaux:', levels);
    }
  */
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
  }
});




// Gestionnaires d'événements supplémentaires
    NV11.on('NOTE_REJECTED', result => {
        let data = { 'status': { 'message': 'Note rejected', 'value': 'warning' } };
        noteInProcessing = false;
        NV11.command('LAST_REJECT_CODE').then(result => {
            console.log("Resultat de LAST_REJECT_CODE:", result);
            data.status.message = result.info.description;
            postWithRetry(data,SERVER_URL)
                .catch(error => {
                    console.error(`Erreur lors de l'envoi: ${data.status.message}`);
                });
        }).catch(err => {
            console.error("Erreur lors de la récupération du code de rejet: ", err);
        });
    });

    NV11.on('STACKER_FULL', result => {
        const data = { status: { message: `${result.info.description}`, value: 'error' } };
        noteInProcessing = false;
        postWithRetry(data, SERVER_URL)
            .catch(error => {
                console.error(`Erreur lors de l'envoi: ${data.status.message}`);
            });
    });

    NV11.on('CASHBOX_REMOVED', result => {
        const data = { status: { message: `${result.info.description}`, value: 'error' } };
        noteInProcessing = false;
        postWithRetry(data, SERVER_URL)
            .catch(error => {
                console.error(`Erreur lors de l'envoi: ${data.status.message}`);
            });
    });

    NV11.on('UNSAFE_NOTE_JAM', result => {
        const data = { status: { message: `${result.info.description}`, value: 'error' } };
        noteInProcessing = false;
        postWithRetry(data, SERVER_URL)
            .catch(error => {
                console.error(`Erreur lors de l'envoi: ${data.status.message}`);
            });
    });

    NV11.on('READ_NOTE', result => {
        if (!noteInProcessing) {
            noteInProcessing = true; // Marquer que la note est en traitement
            postWithRetry({ 'status': { 'message': 'Note in processing', 'value': 'process' } },SERVER_URL)
                .then(() => {
                    console.log("Data successfully sent for 'Note in processing'");
                })
                .catch(error => {
                    console.error(`Final failure to send 'Note in processing' data: ${error.message}`);
                });
        }
    });
// === Gestion d’un billet inséré (CREDIT_NOTE) ===
NV11.on('CREDIT_NOTE', result => {
  if (isStacking) {
        checkNoteSlotsStatus()
            .then(({ usedSlotCount, remainingSlots }) => {
                console.log(`Slots: utilisés=${usedSlotCount}, restants=${remainingSlots}`);
            })
            .catch((error) => {
                console.error(`Final failure: ${error.message}`);
            });

        console.log("⚠️ CREDIT_NOTE ignoré car séquence STACK en cours");
        return;
    }

  const processCreditNote = async () => {
    try {
      const noteId = result.channel;
      if (!NOTE_VALUES[noteId]) {
        console.log(`❓ Billet inconnu, channel=${noteId}`);
        return;
      }

      const noteValue = NOTE_VALUES[noteId];
      noteInProcessing = false;

      totalPaid += noteValue;
      console.log(`💵 Billet inséré: ${noteValue}€ | Total payé: ${totalPaid}€ / dû: ${amountValue}€`);

      // ✅ On notifie le serveur (optionnel)
      await postWithRetry({ status: { note: noteValue, value: 'credited' } },SERVER_URL);

      // ✅ Vérification de l’état du validateur
      const { usedSlotCount, remainingSlots } = await checkNoteSlotsStatus();
      console.log(`Slots NV11: utilisés=${usedSlotCount}, restants=${remainingSlots}`);

      // === Vérifie si le montant dû est atteint ===
      if (totalPaid >= amountValue) {
        const rendu = +(totalPaid - amountValue).toFixed(2);

        if (rendu > 0) {
          console.log(`💶 Rendu à effectuer: ${rendu}€`);
          await handleRenduMixte(rendu);  // 🔁 billets + pièces
        } else {
          console.log('✅ Paiement exact, aucun rendu.');
        }

        // 🔄 Réinitialise l’état pour la prochaine transaction
        totalPaid = 0;
        amountValue = null;
      }

    } catch (error) {
      console.error(`❌ Erreur processCreditNote: ${error.message}`);
    }
  };

  processCreditNote();
});

    
//SMART HOPPER Function
// Fonction pour votre logique métier
function handleCoinInserted(amount, currency) {
  console.log(`💰 Traitement pièce: ${amount} ${currency}`);
  
  // ===== VOTRE CODE ICI =====
  try {
    postWithRetry({ 
      status: { 
        note: amount, 
        value: 'credited',
        //currency: currency,
       // timestamp: new Date().toISOString()
      } 
    },SERVER_URL);
  } catch (error) {
    console.error(`Erreur envoi: ${error.message}`);
  }
}



// === Gestion d’une pièce insérée ===
Hopper.on('COIN_CREDIT', async (event) => {
  try {
    // Vérifie la structure de l'événement
    if (!event.value || !Array.isArray(event.value)) {
      console.warn('❌ Format inattendu de COIN_CREDIT:', event);
      return;
    }

    for (const coin of event.value) {
      const amount = coin.value / 100; // conversion centimes → euros
      const currency = coin.country_code || 'EUR';

      console.log(`🪙 Pièce détectée: ${amount.toFixed(2)} ${currency}`);

      // ✅ Notifie le serveur (API Laravel)
      handleCoinInserted(amount, currency);

      // 🔢 Met à jour le total payé
      totalPaid += amount;
      console.log(`💰 Total payé: ${totalPaid.toFixed(2)}€ / dû: ${amountValue}€`);

      // 💡 Vérifie si le montant dû est atteint
      if (totalPaid >= amountValue) {
        const rendu = +(totalPaid - amountValue).toFixed(2);

        if (rendu > 0) {
          console.log(`💶 Rendu à effectuer: ${rendu}€`);
          await handleRenduMixte(rendu); // ⚙️ billet(s) + pièce(s)
        } else {
          console.log('✅ Paiement exact, aucun rendu.');
        }

        // 🔄 Reset pour la prochaine transaction
        totalPaid = 0;
        amountValue = null;
      }
    }
  } catch (error) {
    console.error('❌ Erreur COIN_CREDIT:', error.message);
  }
});






// Ouverture de la connexion au validateur
    NV11.open(NV11_PORT);
    Hopper.open(HOPPER_PORT);

/**
 * Fonction pour faire une requête POST avec retry et timeout
 */
function postWithRetry(data, url, retries = 3, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const attemptPost = (retryCount) => {
            axios.post(url, data, {
                headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
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
                        sendEmail(EMAIL_SUBJECT, `Error: Failed to send data to server after retries.\n\nException: ${error}`);
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
        console.log('📦 Résultat brut GET_NOTE_POSITIONS:', JSON.stringify(resultSlots, null, 2));

        const slots = resultSlots.info.slot;
        const usedSlotCount = Object.keys(slots).length;

        const MAX_SLOTS = 30;
        const remainingSlots = MAX_SLOTS - usedSlotCount;

        console.log(`🔍 ${remainingSlots} positions libres (sur ${MAX_SLOTS})`);
        console.log('➡️ Condition de test:', remainingSlots, remainingSlots >= 26);
        console.log('🔎 Type de remainingSlots:', typeof remainingSlots, remainingSlots);

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
 * Gère le rendu via NV11 (billets) + Hopper (pièces)
 */
async function handleRenduMixte(rendu) {
  const { billets10, reste } = calculerRenduMixte(rendu);
  console.log(`💶 Rendu total ${rendu}€ -> ${billets10}x10€ + ${reste}€ en pièces`);

  /*if (isPayoutInProgress) {
    console.warn('⚠️ Rendu déjà en cours, commande ignorée.');
    return;
  }*/

  isPayoutInProgress = true;

  try {
    // === 1️⃣ Rendu billets ===
    if (billets10 > 0) {
      console.log(`🧾 NV11 : rendu ${billets10} billet(s) de 10€`);
      console.log('⌛ Commande de rendu billets programmée dans 2s...');
      setTimeout(() => {
        handlePayoutRequest(billets10);
      }, 1000);
    }

    // === 2️⃣ Rendu pièces ===
    if (reste > 0) {
  const hopperAmount = Math.round(reste * 100);
  console.log(`🪙 Hopper : rendu ${reste}€ (${hopperAmount} cts) en pièces...`);

  // Crée une promesse qui se résout quand l'événement DISPENSED est reçu
  const dispensePromise = new Promise((resolve, reject) => {
    const onDispensed = async (data) => {
      console.log(`✅ Event DISPENSED reçu: ${JSON.stringify(data)}`);

      // Nettoyage des listeners
      Hopper.off('DISPENSED', onDispensed);
      Hopper.off('ERROR', onError);

      try {
        // --- Récupération des niveaux ---
        const levels = await Hopper.command('GET_ALL_LEVELS');
        console.log('📊 Niveaux Hopper après rendu:', levels.info.counter);

        // --- Envoi au serveur principal (post-rendu) ---
        await postWithRetry(
          { status: { note: reste, value: 'debited' } },
          SERVER_URL
        );
        console.log('📨 Statut de débit envoyé à Laravel');

        // --- Envoi d’un rapport détaillé au serveur Hopper ---
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

        resolve();
      } catch (err) {
        console.error('⚠️ Erreur dans onDispensed:', err.message);
        reject(err);
      }
    };

    const onError = (err) => {
      Hopper.off('DISPENSED', onDispensed);
      Hopper.off('ERROR', onError);
      console.error('❌ Erreur Hopper pendant PAYOUT:', err.message);
      reject(err);
    };

    Hopper.on('DISPENSED', onDispensed);
    Hopper.on('ERROR', onError);
  });

  // --- Lancement du payout ---
  await Hopper.command('PAYOUT_AMOUNT', {
    amount: hopperAmount,
    country_code: 'EUR',
    test: false,
  });

  // --- Attente de la fin réelle du payout ---
  await dispensePromise;
}
} catch (error) {
        console.error('❌ Erreur lors de l\'envoi à Laravel :', error.message);
    }
}







function handlePayoutRequest(count) {
    let dispensed = 0;
   // isPayoutInProgress = true;

       /* NV11.disable()
            .then(() => {
            // isPayoutInProgress = false;
                console.log('✅ Payout terminé. Validator désactivé');
            })
*/
            const onDispensed = () => {
                dispensed++;
                console.log(`✅ Note ${dispensed}/${count} dispensed`);
            
                // 👇 Ajout ici : on loggue chaque note rendue
                postWithRetry({ status: { note: 10, value: 'debited' } },SERVER_URL)
                    .then(() => {
                        console.log('📨 Débit enregistré dans le serveur');
                    })
                    .catch((err) => {
                        console.error('⚠️ Échec de l’envoi du débit:', err.message);
                    });
            
                if (dispensed >= count) {
                    NV11.off('DISPENSED', onDispensed);
                    NV11.disable()
                        .then(() => {
                            console.log('✅ Payout terminé. Validator désactivé');
                        })
                        .catch(console.error);
                    return;
                }
            
                // Attendre 1 seconde avant la prochaine commande
                setTimeout(() => {
                    NV11.command('PAYOUT_NOTE').catch(console.error);
                }, 1000);
            };
            

            // Important: s’assurer qu’aucun ancien listener traîne
            NV11.off('DISPENSED', onDispensed); 
            NV11.on('DISPENSED', onDispensed);

            NV11.enable()
                .then(() => NV11.command('ENABLE_PAYOUT_DEVICE', {
                    GIVE_VALUE_ON_STORED: true,
                    NO_HOLD_NOTE_ON_PAYOUT: false,
                }))
                .then(() => {
                    console.log(`⏳ Début du rendu de ${count} billet(s)...`);
                    return NV11.command('PAYOUT_NOTE'); // premier billet
                })
                .catch(err => {
                    NV11.off('DISPENSED', onDispensed);
                    console.error('Erreur lors du payout initial:', err);
                });

            // Failsafe timeout
            setTimeout(() => {
                NV11.off('DISPENSED', onDispensed);
                console.warn('⏱ Listener DISPENSED retiré après timeout (failsafe)');
            }, count * 30000);
        }

async function sendSlotStatusToLaravel(used, remaining, alertSent) {
    try {
        const response = await fetch('http://smartcoins.local/api/cash/slot-status', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 'Authorization': 'Bearer VOTRE_TOKEN', // Si besoin
            },
            body: JSON.stringify({
                used_slots: used,
                remaining_slots: remaining,
                alert_sent: alertSent,
            }),
        });

        const result = await response.json();
        console.log('✅ Enregistré dans Laravel :', result.message);
    } catch (error) {
        console.error('❌ Erreur lors de l\'envoi à Laravel :', error.message);
    }
}


//API routes
// Routes HTTP protégées par le middleware d'authentification
app.post('/enable', authenticateToken, (req, res) => {
    const { amount } = req.body;
    const { stacking } = req.body;
    amountValue = amount;
    isStacking = stacking;
    NV11.enable()
        .then(result => res.json({ status: 'NV11 enabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to enable validator', details: error }));
    Hopper.enable();
});

app.post('/disable', authenticateToken, (req, res) => {
    /*if (isPayoutInProgress) {
        return res.status(403).json({ error: 'Cannot disable while payout in progress' });
    }*/
    NV11.disable()
        .then(result => res.json({ status: 'Validator disabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to disable validator', details: error }));
    Hopper.disable();
});

function waitForEvent(emitter, eventName, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            emitter.removeListener(eventName, onEvent);
            reject(new Error(`Timeout waiting for event: ${eventName}`));
        }, timeoutMs);

        function onEvent(data) {
            clearTimeout(timer);
            resolve(data);
        }

        emitter.once(eventName, onEvent);
    });
}


app.post('/collect', authenticateToken, async (req, res) => {
    try {
        lastCommand = 'SMART_EMPTY';
        await NV11.enable();
        await new Promise(r => setTimeout(r, 500));

        console.log("➡️ Envoi SMART_EMPTY...");
        const emptyResult = await NV11.command('SMART_EMPTY');
        /*
        const finalResult = await waitForEvent(NV11, 'SMART_EMPTIED', 10000);

        await NV11.disable();
        console.log('✅ NV11 disabled after SMART_EMPTIED');
        */
        res.json({
            status: 'Cashbox emptied successfully',
            result: emptyResult,
            // event: finalResult
        });

    } catch (error) {
        console.error('❌ Collect error:', error);
        res.status(500).json({
            error: 'Failed to process cashbox collection',
            details: error.message || error
        });
    } finally {
        lastCommand = null; // 🔑 toujours reset

        try {
            const { usedSlotCount, remainingSlots } = await checkNoteSlotsStatus();
            console.log(`📊 Slots après collect: utilisés=${usedSlotCount}, restants=${remainingSlots}`);
        } catch (err) {
            console.error(`⚠️ Impossible de lire l’état des slots: ${err.message}`);
        }
    }
});


app.post('/collectHopper', authenticateToken, async (req, res) => {
    try {
        lastCommand = 'SMART_EMPTY';
        await Hopper.enable();
        await new Promise(r => setTimeout(r, 500));

        console.log("➡️ Envoi SMART_EMPTY...");
        const emptyResult = await Hopper.command('SMART_EMPTY');
        /*
        const finalResult = await waitForEvent(NV11, 'SMART_EMPTIED', 10000);

        await NV11.disable();
        console.log('✅ NV11 disabled after SMART_EMPTIED');
        */
        res.json({
            status: 'Cashbox emptied successfully',
            result: emptyResult,
            // event: finalResult
        });

    } catch (error) {
        console.error('❌ Collect error:', error);
        res.status(500).json({
            error: 'Failed to process cashbox collection',
            details: error.message || error
        });
    } finally {
        lastCommand = null; // 🔑 toujours reset

        try {
            const { usedSlotCount, remainingSlots } = await checkNoteSlotsStatus();
            console.log(`📊 Slots après collect: utilisés=${usedSlotCount}, restants=${remainingSlots}`);
        } catch (err) {
            console.error(`⚠️ Impossible de lire l’état des slots: ${err.message}`);
        }
    }
});


app.post('/hopperStack', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  const { denomination } = req.body;
  console.log('✅ Denomination:', denomination);

  try {
    const quantity = amount;
    // isStacking = stacking; // à réactiver si besoin

    // --- Activation du hopper ---
    const enableResult = await Hopper.enable();
    console.log('✅ Hopper activé:', enableResult);

    // --- Réglage du niveau pour une dénomination donnée ---
    const setLevelResult = await Hopper.command('SET_DENOMINATION_LEVEL', {
      value: quantity,
      denomination: denomination*100,
      country_code: 'EUR'
    });
    console.log('⚙️ Niveau défini pour €:', setLevelResult);

    // --- Réponse HTTP ---
    res.json({
      status: 'ok',
      message: 'Hopper enabled and denomination level set',
      enableResult,
      setLevelResult
    });

  } catch (error) {
    console.error('❌ Erreur /hopperStack:', error);
    res.status(500).json({
      error: 'Failed to enable hopper or set denomination level',
      details: error.message
    });
  }
});



app.post('/stack', authenticateToken, async (req, res) => {
try {
        
        await NV11.enable();
        res.json({
            status: 'Waiting for stacking notes',
            
        });
        
    } catch (error) {
        console.error('❌ Collect error:', error);
        res.status(500).json({
            error: 'Failed to process cashbox collection',
            details: error.message || error
        });
    }
});




app.post('/reset', authenticateToken, (req, res) => {
    console.log("Attempting to reset the validator...");

    NV11.command('RESET')
        .then(result => {
            console.log("Validator reset command sent successfully.", result);
            res.json({ status: 'Validator reset', result });

            console.log("Waiting for the validator to restart...");

            setTimeout(() => {
                console.log("Cleaning up previous validator instance...");

                // Nettoyer les listeners de l'ancienne instance
                NV11.removeAllListeners();
                NV11.close && NV11.close(); // Si une méthode close() existe, sinon ignore

                // Réinitialiser complètement
                NV11 = initializeValidator(COM_PORT);
            }, 5000);
        })
        .catch(error => {
            console.error('Failed to reset validator:', error);
            res.status(500).json({ error: 'Failed to reset validator', details: error });
        });
});



process.on('SIGINT', async () => {
  console.log('\n🧹 Fermeture propre...');
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


// === Lancement du serveur HTTP ===
app.listen(8002, () => {
  console.log('🚀 Serveur NV11 démarré sur le port 8002');
});







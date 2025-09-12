const express = require('express');
const sspLib = require('@tidemx/encrypted-smiley-secure-protocol');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// Configuration
const COM_PORT = '/dev/ttyACM0';
const SERVER_URL = 'http://smartcoins.local/cash/endpoint';
const AUTH_TOKEN = '4GH59FD3KG9rtgijeoitvCE3440sllg';
const EMAIL_FROM = 'info@sallelafraternite.be';
const EMAIL_TO = 'legrandse@gmail.com';
const EMAIL_SUBJECT = 'Validator Error Notification';
const NOTE_VALUES = { 1: 5, 2: 10, 3: 20, 4: 50, 5: 100, 6: 200, 7: 500 };

let noteInProcessing = false;
let amountValue = null;
let isPayoutInProgress = false;
let eSSP; // Déclaration globale pour l'objet eSSP

/**
 * Fonction pour initialiser le validateur
 */
function initializeValidator(comPort, fixedKey = '0123456701234567') {
    let eSSP = new sspLib({
        id: 0,
        debug: true,
        timeout: 3000,
        fixedKey: fixedKey
    });

    eSSP.on('OPEN', () => {
        console.log('Validator connection open');
        eSSP
            .command('SYNC')
            .then(() => eSSP.command('HOST_PROTOCOL_VERSION', { version: 6 }))
            .then(() => eSSP.initEncryption())
            .then(() => eSSP.command('GET_SERIAL_NUMBER'))
            .then(result => {
                console.log('Serial Number:', result.info.serial_number);
            })
            .then(() => eSSP.command('SET_CHANNEL_INHIBITS', { channels: [1, 1, 1, 1, 0, 0, 0, 0] }))
            
            
            .then(() => eSSP.command('SET_DENOMINATION_ROUTE', { route:'payout', value:1000, country_code:'EUR' }))
            //.then(() => eSSP.command('GET_DENOMINATION_ROUTE', {isHopper: false,  value: 1000, country_code: 'EUR' }))
            .then(() => eSSP.command('ENABLE_PAYOUT_DEVICE', {
                GIVE_VALUE_ON_STORED: true,
                NO_HOLD_NOTE_ON_PAYOUT: false,
              }))
            .then(() => eSSP.disable())
            .then(result => {
                if (result.status === 'OK') {
                    console.log('Device is initialized and channels are enabled');
                }
            })

            .catch(err => {
                console.error('Error during initialization:', err);
            })
            
            
    });
    
    
    // Gestionnaires d'événements supplémentaires
    eSSP.on('NOTE_REJECTED', result => {
        let data = { 'status': { 'message': 'Note rejected', 'value': 'warning' } };
        noteInProcessing = false;
        eSSP.command('LAST_REJECT_CODE').then(result => {
            console.log("Resultat de LAST_REJECT_CODE:", result);
            data.status.message = result.info.description;
            postWithRetry(data)
                .catch(error => {
                    console.error(`Erreur lors de l'envoi: ${data.status.message}`);
                });
        }).catch(err => {
            console.error("Erreur lors de la récupération du code de rejet: ", err);
        });
    });

    eSSP.on('STACKER_FULL', result => {
        const data = { status: { message: `${result.info.description}`, value: 'error' } };
        noteInProcessing = false;
        postWithRetry(data)
            .catch(error => {
                console.error(`Erreur lors de l'envoi: ${data.status.message}`);
            });
    });

    eSSP.on('CASHBOX_REMOVED', result => {
        const data = { status: { message: `${result.info.description}`, value: 'error' } };
        noteInProcessing = false;
        postWithRetry(data)
            .catch(error => {
                console.error(`Erreur lors de l'envoi: ${data.status.message}`);
            });
    });

    eSSP.on('UNSAFE_NOTE_JAM', result => {
        const data = { status: { message: `${result.info.description}`, value: 'error' } };
        noteInProcessing = false;
        postWithRetry(data)
            .catch(error => {
                console.error(`Erreur lors de l'envoi: ${data.status.message}`);
            });
    });

    eSSP.on('READ_NOTE', result => {
        if (!noteInProcessing) {
            noteInProcessing = true; // Marquer que la note est en traitement
            postWithRetry({ 'status': { 'message': 'Note in processing', 'value': 'process' } })
                .then(() => {
                    console.log("Data successfully sent for 'Note in processing'");
                })
                .catch(error => {
                    console.error(`Final failure to send 'Note in processing' data: ${error.message}`);
                });
        }
    });
/*
    eSSP.on('CREDIT_NOTE', result => {
        const noteId = result.channel;
        if (NOTE_VALUES[noteId]) {
            const noteValue = NOTE_VALUES[noteId];
            noteInProcessing = false;
            postWithRetry({ 'status': { 'note': noteValue, 'value': 'credited' } })
                .catch(error => {
                    console.error(`Final failure: ${error.message}`);
                });
        } else {
            console.log(`Unknown note ID: ${noteId}`);
        }
    });
*/
/*
eSSP.on('CREDIT_NOTE', result => {
    const noteId = result.channel;
    if (NOTE_VALUES[noteId]) {
        const noteValue = NOTE_VALUES[noteId];
        noteInProcessing = false;

        const jetonValue = amountValue || 0;
        const rendu = noteValue - jetonValue;
        //console.log(`rendu: ${rendu}`);

        postWithRetry({ 'status': { 'note': noteValue, 'value': 'credited' } })
            .then(() => {
                if (rendu > 0) {
                    const denomination = 10; // La valeur de chaque billet de rendu
                    const payoutCount = Math.floor(rendu / denomination);
                    const reste = rendu % denomination;

                    console.log(`💶 ${noteValue}€ reçu. Jetons: ${jetonValue}€. Rendu: ${rendu}€ -> ${payoutCount} x ${denomination}€`);

                    if (reste > 0) {
                        console.warn(`⚠️ Impossible de rendre ${reste}€ (non divisible par ${denomination})`);
                        // Optionnel : envoyer info à l'API ou par mail
                    }
                    const notePosition = eSSP.command('GET_NOTE_POSITIONS', {});
                    setTimeout(() => {
                        handlePayoutRequest(payoutCount);
                    }, 2000); // ⏱ délai de 5 secondes
                }
            })
            .catch(error => {
                console.error(`Final failure: ${error.message}`);
            });
    } else {
        console.log(`Unknown note ID: ${noteId}`);
    }
});
*/
    eSSP.on('CREDIT_NOTE', result => {
    const processCreditNote = async () => {
        const noteId = result.channel;
        if (NOTE_VALUES[noteId]) {
            const noteValue = NOTE_VALUES[noteId];
            noteInProcessing = false;

            const jetonValue = amountValue || 0;
            const rendu = noteValue - jetonValue;

            try {
                await postWithRetry({ status: { note: noteValue, value: 'credited' } });

                // ✅ On vérifie l’état des slots quelle que soit la valeur du billet
                const { usedSlotCount, remainingSlots } = await checkNoteSlotsStatus();

                if (rendu >= 10) {
                    const denomination = 10;
                    const payoutCount = Math.floor(rendu / denomination);
                    const reste = rendu % denomination;

                    console.log(`💶 ${noteValue}€ reçu. Jetons: ${jetonValue}€. Rendu: ${rendu}€ -> ${payoutCount} x ${denomination}€`);

                    if (reste > 0) {
                        console.warn(`⚠️ Impossible de rendre ${reste}€ (non divisible par ${denomination})`);
                    }

                    setTimeout(() => {
                        handlePayoutRequest(payoutCount);
                    }, 2000);
                } else {
                    console.log(`✅ Aucun rendu nécessaire. Le billet de ${noteValue}€ correspond exactement au montant dû.`);
                }
            } catch (error) {
                console.error(`Final failure: ${error.message}`);
            }
        } else {
            console.log(`Unknown note ID: ${noteId}`);
        }
    };

    processCreditNote();
});





    // Ouverture de la connexion au validateur
    eSSP.open(comPort);

    return eSSP;






    
}

async function checkNoteSlotsStatus() {
    try {
        const resultSlots = await eSSP.command('GET_NOTE_POSITIONS');
        console.log('📦 Résultat brut GET_NOTE_POSITIONS:', JSON.stringify(resultSlots, null, 2));

        const slots = resultSlots.info.slot;
        const usedSlotCount = Object.keys(slots).length;

        const MAX_SLOTS = 31;
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
 * Fonction pour envoyer un email
 */
function sendEmail(subject, body) {
    const transporter = nodemailer.createTransport({
        service: 'Mailjet',
        auth: {
            user: 'aedf6b569bcf7aec922a6481a4bea307',
            pass: 'f388fa510c2f4b473ecee01437db9fb3'
        }
    });

    const mailOptions = {
        from: EMAIL_FROM,
        to: EMAIL_TO,
        subject: subject,
        text: body
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error(`Failed to send email: ${error}`);
        } else {
            console.log(`Email sent: ${info.response}`);
        }
    });
}

/**
 * Fonction pour faire une requête POST avec retry et timeout
 */
function postWithRetry(data, retries = 3, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const attemptPost = (retryCount) => {
            axios.post(SERVER_URL, data, {
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

/**
 * Initialisation du validateur
 */
eSSP = initializeValidator(COM_PORT);



// Routes HTTP protégées par le middleware d'authentification
app.post('/enable', authenticateToken, (req, res) => {
    const { amount } = req.body;
    amountValue = amount;
    eSSP.enable()
        .then(result => res.json({ status: 'Validator enabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to enable validator', details: error }));
});

app.post('/disable', authenticateToken, (req, res) => {
    /*if (isPayoutInProgress) {
        return res.status(403).json({ error: 'Cannot disable while payout in progress' });
    }*/
    eSSP.disable()
        .then(result => res.json({ status: 'Validator disabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to disable validator', details: error }));
});

app.post('/collect', authenticateToken, async (req, res) => {
    try {
        // D'abord activer le périphérique
        await eSSP.enable();

        // Ensuite lancer la commande d'évacuation
        const emptyResult = await eSSP.command('SMART_EMPTY');

        /* Si tu veux garder les infos sur les billets
        const notePositions = await eSSP.command('GET_NOTE_POSITIONS');
        const slotToLaravel = await sendSlotStatusToLaravel(0, 30, 0);
        */

        res.json({ 
            status: 'Emptying cashbox',
            result: emptyResult,
            // notePositions
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to process cashbox collection',
            details: error.message || error
        });
    }
});







app.post('/reset', authenticateToken, (req, res) => {
    console.log("Attempting to reset the validator...");

    eSSP.command('RESET')
        .then(result => {
            console.log("Validator reset command sent successfully.", result);
            res.json({ status: 'Validator reset', result });

            console.log("Waiting for the validator to restart...");

            setTimeout(() => {
                console.log("Cleaning up previous validator instance...");

                // Nettoyer les listeners de l'ancienne instance
                eSSP.removeAllListeners();
                eSSP.close && eSSP.close(); // Si une méthode close() existe, sinon ignore

                // Réinitialiser complètement
                eSSP = initializeValidator(COM_PORT);
            }, 5000);
        })
        .catch(error => {
            console.error('Failed to reset validator:', error);
            res.status(500).json({ error: 'Failed to reset validator', details: error });
        });
});


function handlePayoutRequest(count) {
    let dispensed = 0;
   // isPayoutInProgress = true;

       /* eSSP.disable()
            .then(() => {
            // isPayoutInProgress = false;
                console.log('✅ Payout terminé. Validator désactivé');
            })
*/
            const onDispensed = () => {
                dispensed++;
                console.log(`✅ Note ${dispensed}/${count} dispensed`);
            
                // 👇 Ajout ici : on loggue chaque note rendue
                postWithRetry({ status: { note: 10, value: 'debited' } })
                    .then(() => {
                        console.log('📨 Débit enregistré dans le serveur');
                    })
                    .catch((err) => {
                        console.error('⚠️ Échec de l’envoi du débit:', err.message);
                    });
            
                if (dispensed >= count) {
                    eSSP.off('DISPENSED', onDispensed);
                    eSSP.disable()
                        .then(() => {
                            console.log('✅ Payout terminé. Validator désactivé');
                        })
                        .catch(console.error);
                    return;
                }
            
                // Attendre 1 seconde avant la prochaine commande
                setTimeout(() => {
                    eSSP.command('PAYOUT_NOTE').catch(console.error);
                }, 1000);
            };
            

            // Important: s’assurer qu’aucun ancien listener traîne
            eSSP.off('DISPENSED', onDispensed); 
            eSSP.on('DISPENSED', onDispensed);

            eSSP.enable()
                .then(() => eSSP.command('ENABLE_PAYOUT_DEVICE', {
                    GIVE_VALUE_ON_STORED: true,
                    NO_HOLD_NOTE_ON_PAYOUT: false,
                }))
                .then(() => {
                    console.log(`⏳ Début du rendu de ${count} billet(s)...`);
                    return eSSP.command('PAYOUT_NOTE'); // premier billet
                })
                .catch(err => {
                    eSSP.off('DISPENSED', onDispensed);
                    console.error('Erreur lors du payout initial:', err);
                });

            // Failsafe timeout
            setTimeout(() => {
                eSSP.off('DISPENSED', onDispensed);
                console.warn('⏱ Listener DISPENSED retiré après timeout (failsafe)');
            }, count * 30000);
        }

async function sendSlotStatusToLaravel(used, remaining, alertSent) {
    try {
        const response = await fetch('http://smartcoins.local/api/slot-status', {
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






// Démarrer le serveur
const PORT = 8002;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});



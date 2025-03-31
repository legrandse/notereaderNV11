const express = require('express');
const sspLib = require('@tidemx/encrypted-smiley-secure-protocol')
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// Configuration
const COM_PORT = '/dev/ttyACM0'; // Changez si nécessaire
const SERVER_URL = 'http://smartcoins.local/cash/endpoint';
const AUTH_TOKEN = 'c13dffba-a4c0-4322-b5f0-83803770dd20';
const EMAIL_FROM = 'info@sallelafraternite.be';
const EMAIL_TO = 'legrandse@gmail.com';
const EMAIL_SUBJECT = 'Validator Error Notification';

// Fonction pour faire une requête POST avec retry et timeout

let noteInProcessing = false;  // Flag pour vérifier si une note est en traitement
let amountValue = null;  // Variable pour stocker le montant


function postWithRetry(data, retries = 3, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const attemptPost = (retryCount) => {
            axios.post(SERVER_URL, data, {
                headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
                timeout: timeout  // Timeout de 5 secondes (ajustable)
            })
            .then(response => {
                console.log(`Sent data to server: ${data.status.note}, response: ${response.status}`);
                resolve(response);
            })
            .catch(error => {
                if (retryCount > 0) {
                    console.warn(`Retrying... Attempts left: ${retryCount}. Error: ${error.message}`);
                    setTimeout(() => attemptPost(retryCount - 1), 1000);  // Attente de 1 seconde avant de réessayer
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

    if (!token) {
        return res.status(401).json({ error: 'Token not provided' });
    }

    // Vérifiez si le token est valide (ici on le compare simplement à AUTH_TOKEN, mais on peut utiliser JWT ou autre)
    if (token !== AUTH_TOKEN) {
        return res.status(403).json({ error: 'Invalid token' });
    }

    // Le token est valide, continuer avec la requête
    next();
}


// Dictionnaire des valeurs des billets
const NOTE_VALUES = {
    1: 5,
    2: 10,
    3: 20,
    4: 50,
    5: 100,
    6: 200,
    7: 500
};

// Configuration de la bibliothèque eSSP
let eSSP = new sspLib({
    id: 0,
    debug: false,
    timeout: 3000,
    fixedKey: '0123456701234567'
});

// Fonction d'initialisation centralisée
function initializeValidator() {
    // Étape 1 : Initialiser la connexion
    eSSP.open(COM_PORT)
        .then(() => {
            console.log('Connexion ouverte.');

            // Étape 2 : Définir explicitement la clé d'encryption
            return eSSP.command('SET_FIXED_ENCRYPTION_KEY', {
                fixedKey: '0123456701234567'  // Exemple de clé fixe (modifiez-la selon vos besoins)
            });
        })
        .then(() => {
            console.log('Clé d\'encryption définie.');

            // Étape 3 : Synchronisation du périphérique
            return eSSP.command('SYNC');
        })
        .then(() => {
            // Étape 4 : Vérification de la version du protocole
            return eSSP.command('HOST_PROTOCOL_VERSION', { version: 6 });
        })
        .then(() => {
            // Étape 5 : Récupérer le numéro de série
            return eSSP.command('GET_SERIAL_NUMBER');
        })
        .then(result => {
            console.log('Numéro de série du périphérique:', result.info.serial_number);
        })
        .then(() => {
            // Étape 6 : Activer les canaux
            return eSSP.command('SET_CHANNEL_INHIBITS', { channels: [1, 1, 1, 1, 0, 0, 0, 0] });
        })
        .then(() => {
            // Étape 7 : Désactiver l'appareil après configuration
            return eSSP.disable();
        })
        .then(result => {
            if (result.status === 'OK') {
                console.log('Périphérique activé avec les canaux configurés');
            }
        })
        .catch(err => {
            console.error("Erreur d'initialisation du périphérique : ", err);
        });
}



/*
eSSP.on('NOTE_REJECTED', result => {
    const data = { 'status': { 'message': 'Erreur de lecture du billet. Veuillez svp réintroduire celui-ci...', 'value': 'warning' } };
    noteInProcessing = false;
     
    // Envoi des données au serveur avec retry et timeout
    postWithRetry(data)
        .catch(error => {
            console.error(`data: ${status.message}`);
        });
});*/

eSSP.on('NOTE_REJECTED', result => {
    // Initialisation des données de rejet
    let data = { 'status': { 'message': 'Note rejected', 'value': 'warning' } };
    noteInProcessing = false;

    // Demander le dernier code de rejet pour plus de détails
    eSSP.command('LAST_REJECT_CODE').then(result => {
        // Modifier les données pour inclure des détails sur le code de rejet
            console.log("Resultat de LAST_REJECT_CODE:", result);  // Affiche le contenu de result
        data.status.message =  result.info.description;  // Exemple de message
     //   data.status.rejectCode = result;  // Inclure le code de rejet dans les données

        // Envoi des données au serveur après avoir reçu le code de rejet
        postWithRetry(data)
            .catch(error => {
                console.error(`Erreur lors de l'envoi: ${data.status.message}`);
            });
    }).catch(err => {
        console.error("Erreur lors de la récupération du code de rejet: ", err);
    });
});


eSSP.on('STACKER_FULL', result => {
    const data = { 'status': { 'message': 'The banknote stacker unit attached to this device has been detected as at its full limit', 'value': 'error' } };
    noteInProcessing = false; 
    // Envoi des données au serveur avec retry et timeout
    postWithRetry(data)
        .catch(error => {
            console.error(`Erreur : ${data.status.message}`);
        });
});
eSSP.on('CASHBOX_REMOVED', result => {
    const data = { 'status': { 'message': 'A device with a detectable cashbox has detected that it has been removed.', 'value': 'error' } };
    noteInProcessing = false; 
    // Envoi des données au serveur avec retry et timeout
    postWithRetry(data)
        .catch(error => {
            console.error(`data: ${data.status.message}`);
        });
});

eSSP.on('UNSAFE_NOTE_JAM', result => {
    const data = { 'status': { 'message': 'The note is stuck in a position where the user could possibly remove it from the front of the device.', 'value': 'error' } };
    noteInProcessing = false; 
    // Envoi des données au serveur avec retry et timeout
    postWithRetry(data)
        .catch(error => {
            console.error(`data: ${data.status.message}`);
        });
});


// Écoute de l'événement READ_NOTE
eSSP.on('READ_NOTE', result => {
    if (!noteInProcessing) {
        noteInProcessing = true;  // Marquer que la note est en traitement
        console.log("valeur de result :",result);
        // Envoi des données au serveur avec retry et timeout
        postWithRetry({ 'status': { 'message': 'Note in processing', 'value': 'process' }})
        .then(() => {
            console.log(`Data successfully sent for 'Note in processing'`);
        })
        .catch(error => {
            console.error(`Final failure to send 'Note in processing' data: ${error.message}`);
        });
    }
});
/*
eSSP.on('READ_NOTE', result => {
    if (!noteInProcessing) {
        noteInProcessing = true;  // Marquer que la note est en traitement
        const noteId = result.channel;  // Utilisez 'channel' pour obtenir l'ID de la note
        const noteValue = NOTE_VALUES[noteId];  // Obtenez la valeur de la note
        console.log("Valeur de amountValue lors de READ_NOTE:", amountValue); // Ajout ici        // Comparer la valeur de la note avec amountValue
        console.log("Valeur de noteValue lors de READ_NOTE:", noteValue); // Ajout ici        // Comparer la valeur de la note avec amountValue
        
        // Trouver l'ID dans NOTE_VALUES correspondant à amountValue
        const expectedNoteId = Object.keys(NOTE_VALUES).find(key => NOTE_VALUES[key] === amountValue);
        console.log("valeur expected:", expectedNoteId);
        // Ignorer les événements où le channel est égal à 0
        //if (result.channel == 0) {
        //    return;  // Ne rien faire si le channel est 0
        //}
        if (expectedNoteId === noteId) {
            postWithRetry({ 'status': { 'message': 'Note matches the expected amount', 'value': 'process' }})
                .then(() => {
                    console.log(`Data successfully sent for 'Note matches the expected amount'`);
                })
                .catch(error => {
                    console.error(`Final failure to send matching note data: ${error.message}`);
                });
        } else {
            // Rejeter le billet si la valeur ne correspond pas
            eSSP.command('REJECT_BANKNOTE')
                .then(() => {
                    console.log(`Note rejected: ${noteValue} does not match expected amount: ${amountValue}`);
                    postWithRetry({ 'status': { 'message': 'Note rejected due to mismatch', 'value': 'error' }})
                        .then(() => {
                            console.log(`Data successfully sent for 'Note rejected due to mismatch'`);
                        })
                        .catch(error => {
                            console.error(`Final failure to send rejection data: ${error.message}`);
                        });
                })
                .catch(err => {
                    console.error(`Error rejecting note: ${err.message}`);
                });
        }
    }
});
*/



eSSP.on('CREDIT_NOTE', result => {
    const noteId = result.channel;  // Utilisation de 'channel' au lieu de 'note'
    if (NOTE_VALUES[noteId]) {
        const noteValue = NOTE_VALUES[noteId];
        noteInProcessing = false;  // Marquer que la note est en traitement

        // Envoi des données au serveur avec timeout et retry
        postWithRetry({ 'status': { 'note': noteValue, 'value': 'credited' }})
        .catch(error => {
            console.error(`Final failure: ${error.message}`);
        });
    } else {
        console.log(`Unknown note ID: ${noteId}`);
    }
});
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

// Routes HTTP
/*app.get('/', (req, res) => {
    res.send('Validator Server Running');
});*/
/*
app.post('/enable', (req, res) => {
    eSSP.enable()
        .then(result => res.json({ status: 'Validator enabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to enable validator', details: error }));
});

app.post('/disable', (req, res) => {
    eSSP.disable()
        .then(result => res.json({ status: 'Validator disabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to disable validator', details: error }));
});
*/
// Routes HTTP protégées par le middleware d'authentification
/*app.post('/enable', authenticateToken, (req, res) => {
    eSSP.enable()
        .then(result => res.json({ status: 'Validator enabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to enable validator', details: error }));
});
*/

app.post('/enable', authenticateToken, (req, res) => {
    const { amount } = req.body;  // Récupérez amount du corps de la requête
    amountValue = amount;  // Stockez la valeur dans la variable globale
    console.log("Valeur de amountValue après /enable:", amountValue); // Ajout ici
    eSSP.enable()
        .then(result => res.json({ status: 'Validator enabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to enable validator', details: error }));
});


app.post('/disable', authenticateToken, (req, res) => {
    eSSP.disable()
        .then(result => res.json({ status: 'Validator disabled', result }))
        .catch(error => res.status(500).json({ error: 'Failed to disable validator', details: error }));
});

app.post('/reset', authenticateToken, (req, res) => {
    postWithRetry({ 'status': { 'message': 'Note in processing', 'value': 'process' }});

    eSSP.command('RESET')
        .then(result => {
            res.json({ status: 'Validator reset', result });
            console.log("Validator is resetting, re-establishing connection...");

            // Attendre 10 secondes pour que le périphérique termine complètement son redémarrage
            setTimeout(() => {
                // Réouvrir la connexion
                initializeValidator();  // Appel de la fonction d'initialisation après le reset
            }, 10000);  // Délai de 10 secondes avant de relancer l'initialisation
        })
        .catch(error => res.status(500).json({ error: 'Failed to reset validator', details: error }));
});


// Démarrer le serveur
const PORT = 8002;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    initializeValidator();  // Initialisation lors du démarrage du serveur
});

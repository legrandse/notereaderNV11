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

eSSP.on('OPEN', () => {
  console.log('open');

  eSSP
    .command('SYNC')
    .then(() => eSSP.command('HOST_PROTOCOL_VERSION', { version: 6 }))
    .then(() => eSSP.initEncryption())
    .then(() => eSSP.command('GET_SERIAL_NUMBER'))
    .then(result => {
      console.log('SERIAL NUMBER:', result.info.serial_number);
      return;
    })
    // Ajouter SET_CHANNEL_INHIBITS avant ENABLE
    .then(() => eSSP.command('SET_CHANNEL_INHIBITS', { channels: [1, 1, 1, 1, 0, 0, 0, 0] })) // Active tous les canaux
    .then(() => eSSP.enable())
    .then(result => {
      if (result.status == 'OK') {
        console.log('Device is active with channels enabled');
      }
    })
    .catch(err => {
      console.error('Error during initialization:', err);
    });
});

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
            console.error(`data: ${status.message}`);
        });
});
eSSP.on('CASHBOX_REMOVED', result => {
    const data = { 'status': { 'message': 'A device with a detectable cashbox has detected that it has been removed.', 'value': 'error' } };
    noteInProcessing = false; 
    // Envoi des données au serveur avec retry et timeout
    postWithRetry(data)
        .catch(error => {
            console.error(`data: ${status.message}`);
        });
});

eSSP.on('NOTE_PATH_OPEN', result => {
    const data = { 'status': { 'message': 'A device with a detectable cashbox has detected that it has been removed.', 'value': 'error' } };
    noteInProcessing = false; 
    // Envoi des données au serveur avec retry et timeout
    postWithRetry(data)
        .catch(error => {
            console.error(`data: ${status.message}`);
        });
});


// Écoute de l'événement READ_NOTE
eSSP.on('READ_NOTE', result => {
    if (!noteInProcessing) {
        noteInProcessing = true;  // Marquer que la note est en traitement

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
app.post('/enable', authenticateToken, (req, res) => {
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
    eSSP.reset()
        .then(result => res.json({ status: 'Validator reset', result }))
        .catch(error => res.status(500).json({ error: 'Failed to reset validator', details: error }));
});

// Démarrer le serveur
const PORT = 8002;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    eSSP.open(COM_PORT);
});

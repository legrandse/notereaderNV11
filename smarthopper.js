const express = require('express');
const sspLib = require('@tidemx/encrypted-smiley-secure-protocol');
const axios = require('axios');
const SERVER_URL = 'http://smartcoins.local/cash/endpoint';
const AUTH_TOKEN = '4GH59FD3KG9rtgijeoitvCE3440sllg';

const COM_PORT = '/dev/ttyUSB0';
let total = 0;



const SmartHopper = new sspLib({
  id: 16,
  debug: false,  // ✅ Maintenant ça fonctionne en production
  timeout: 5000,
  fixedKey: '0123456701234567',
});




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
    });
  } catch (error) {
    console.error(`Erreur envoi: ${error.message}`);
  }
}

// Initialisation
SmartHopper.on('OPEN', async () => {
  console.log('✅ Connexion série ouverte');
  
  setTimeout(async () => {
    try {
      await SmartHopper.command('SYNC');
      await SmartHopper.command('HOST_PROTOCOL_VERSION', { version: 6 });
      await SmartHopper.initEncryption();
      await SmartHopper.command('SET_COIN_MECH_GLOBAL_INHIBIT', { enable: true });
      await SmartHopper.command('COIN_MECH_OPTIONS', { ccTalk: false });
      await SmartHopper.enable();
      console.log('✅ RM5 HD prêt - En attente de pièces...');
    } catch (error) {
      console.log('❌ Erreur initialisation:', error);
    }
  }, 1000);
});

SmartHopper.open(COM_PORT).catch(error => {
  console.log('❌ Erreur port série:', error);
});

SmartHopper.on('COIN_CREDIT', (event) => {
  
  
  // EXTRACTION CORRECTE des données
  if (event.value && Array.isArray(event.value)) {
    event.value.forEach(coin => {
      const amount = coin.value / 100; // Conversion centimes → euros
      const currency = coin.country_code;
      
      console.log(`💰 Pièce détectée: ${amount.toFixed(2)} ${currency}`);
      
      // Appel de votre fonction
      handleCoinInserted(amount, currency);
    });
  } else {
    console.log('❌ Format de données inattendu:', event);
  }
});

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



process.on('SIGINT', async () => {
  try {
    await SmartHopper.command('SET_COIN_MECH_GLOBAL_INHIBIT', { enable: false });
    SmartHopper.close();
  } catch (error) {
    console.log('❌ Erreur fermeture:', error);
  }
  process.exit(0);
});
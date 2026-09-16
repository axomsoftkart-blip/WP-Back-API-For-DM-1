const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

let qrDataUrl = '';
let isConnected = false;
let sock;

// Establish lightweight WebSocket connection to WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) // Keeps Render logs clean and saves memory
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrDataUrl = await qrcode.toDataURL(qr);
            isConnected = false;
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            isConnected = false;
            qrDataUrl = '';
            
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                // User logged out from phone. Clear old auth data and restart.
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrDataUrl = '';
            console.log('WhatsApp connection opened successfully!');
        }
    });
}

connectToWhatsApp();

// Endpoint 1: Provides the QR Code interface
app.get('/', (req, res) => {
    if (isConnected) {
        res.send('<h2 style="color: green; text-align: center; font-family: sans-serif; margin-top: 50px;">WhatsApp is Linked and Ready!</h2>');
    } else if (qrDataUrl) {
        res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h2>Scan this QR Code via WhatsApp Linked Devices</h2>
                <img src="${qrDataUrl}" alt="QR Code" style="border: 2px solid #ccc; padding: 10px; border-radius: 8px;">
                <p style="color: gray;">Page refreshes automatically every 5 seconds.</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else {
        res.send('<h3 style="text-align: center; font-family: sans-serif; margin-top: 50px;">Initializing System... Please wait a few seconds.</h3><script>setTimeout(() => location.reload(), 3000);</script>');
    }
});

// Endpoint 2: Receives numbers and messages from Apps Script
app.post('/send', async (req, res) => {
    if (!isConnected) {
        return res.status(400).json({ error: 'WhatsApp is not connected to the backend.' });
    }

    const { numbers, message } = req.body;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !message) {
        return res.status(400).json({ error: 'Missing numbers or message data.' });
    }

    // Acknowledge immediately to prevent Render from timing out the HTTP request
    res.status(200).json({ status: 'queued', message: `Processing ${numbers.length} numbers sequentially.` });

    // Background process for sending messages with delays
    (async () => {
        for (let i = 0; i < numbers.length; i++) {
            const number = numbers[i];
            const jid = `${number}@s.whatsapp.net`; // Baileys formatting requirement

            try {
                await sock.sendMessage(jid, { text: message });
                console.log(`Message sent successfully to ${number}`);
            } catch (err) {
                console.error(`Failed to send message to ${number}:`, err);
            }

            // Random delay between 5 to 30 seconds for all but the last message
            if (i < numbers.length - 1) {
                const delayMs = Math.floor(Math.random() * (30000 - 5000 + 1)) + 5000;
                console.log(`Waiting ${delayMs / 1000} seconds before next send...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        console.log('Batch complete.');
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
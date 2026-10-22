const express = require('express');
const EventNotificationSDK = require('event-notification-nodejs-sdk');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('eBay notification service is running.');
});

app.get('/webhook', (req, res) => {
    const challengeCode = req.query.challenge_code;

    if (!challengeCode) {
        return res.status(400).json({ error: 'Missing challenge_code' });
    }

    try {
        const result = EventNotificationSDK.validateEndpoint(
            challengeCode,
            {
                endpoint: process.env.EBAY_ENDPOINT,
                verificationToken: process.env.EBAY_VERIFICATION_TOKEN
            }
        );

        return res.status(200).json({
            challengeResponse: result.challengeResponse || result
        });
    } catch (error) {
        console.error('Endpoint validation failed.');
        return res.status(500).send();
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const statusCode = await EventNotificationSDK.process(
            req.body,
            req.headers['x-ebay-signature'],
            {
                PRODUCTION: {
                    clientId: process.env.EBAY_CLIENT_ID,
                    clientSecret: process.env.EBAY_CLIENT_SECRET,
                    devId: process.env.EBAY_DEV_ID,
                    baseUrl: 'api.ebay.com'
                },
                SANDBOX: {
                    clientId: '',
                    clientSecret: '',
                    devId: '',
                    baseUrl: 'api.sandbox.ebay.com'
                },
                endpoint: process.env.EBAY_ENDPOINT,
                verificationToken: process.env.EBAY_VERIFICATION_TOKEN
            },
            'PRODUCTION'
        );

        return res.sendStatus(statusCode);
    } catch (error) {
        console.error('Notification processing failed.');
        return res.sendStatus(500);
    }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log('Notification service started.');
});

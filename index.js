const { createHash } = require('crypto');
const express = require('express');
const EventNotificationSDK = require('event-notification-nodejs-sdk');
const accountDeletionProcessor = require('event-notification-nodejs-sdk/lib/processor/accountDeletionMessageProcessor');
const config = {
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
};

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('eBay notification service is running.');
});

app.get('/webhook', (req, res) => {
    const challengeCode = req.query.challenge_code;
    const verificationToken = process.env.EBAY_VERIFICATION_TOKEN;
    const endpoint = process.env.EBAY_ENDPOINT;

    if (!challengeCode || !verificationToken || !endpoint) {
        return res.status(400).json({ error: 'Missing required configuration' });
    }

    const challengeResponse = createHash('sha256')
        .update(challengeCode + verificationToken + endpoint, 'utf8')
        .digest('hex');

    return res.status(200)
        .type('application/json')
        .json({ challengeResponse });
});


app.post('/webhook', async (req, res) => {
    console.log('EBAY WEBHOOK RECEIVED');

    try {
        const statusCode = await EventNotificationSDK.process(
            req.body,
            req.headers['x-ebay-signature'],
            config,
            'PRODUCTION'
        );

        console.log('EBAY PROCESSING STATUS:', statusCode);
        return res.sendStatus(statusCode);
    } catch (error) {
        console.error('EBAY PROCESSING ERROR:', error);
        return res.sendStatus(500);
    }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log('Notification service started.');
});

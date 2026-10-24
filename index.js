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

const CONDITION_LABELS = {
    1000: 'New',
    2750: 'Like New',
    4000: 'Very Good',
    5000: 'Good',
    6000: 'Acceptable'
};

let cachedToken = null;
let tokenExpiresAt = 0;

async function getEbayAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const credentials = Buffer.from(
        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch(
        'https://api.ebay.com/identity/v1/oauth2/token',
        {
            method: 'POST',
            headers: {
                Authorization: `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                scope: 'https://api.ebay.com/oauth/api_scope'
            })
        }
    );

    if (!response.ok) {
        throw new Error(`eBay token request failed: ${response.status}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return cachedToken;
}

async function findLowestPrices(ean, token) {
    const url = new URL(
        'https://api.ebay.com/buy/browse/v1/item_summary/search'
    );

    url.searchParams.set('gtin', ean);
    url.searchParams.set('limit', '200');
    url.searchParams.set('sort', 'price');

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
            'X-EBAY-C-ENDUSERCTX':
                'contextualLocation=country=GB'
        }
    });

    if (!response.ok) {
        throw new Error(
            `eBay search failed for EAN ${ean}: ${response.status}`
        );
    }

    const data = await response.json();
    const results = {};

    for (const label of Object.values(CONDITION_LABELS)) {
        results[label] = null;
    }

    for (const item of (data.itemSummaries || [])) {
        const conditionId = Number(item.conditionId);
        const label = CONDITION_LABELS[conditionId];

        if (!label || !item.itemId) continue;

        const price = Number(item.price?.value);
        if (!Number.isFinite(price)) continue;

        const itemResponse = await fetch(
            `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(item.itemId)}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
                    'X-EBAY-C-ENDUSERCTX':
                        'contextualLocation=country=GB'
                }
            }
        );

        if (!itemResponse.ok) continue;

        const details = await itemResponse.json();
        const shippingOptions = details.shippingOptions || [];

        const shippingCosts = shippingOptions
            .map(option => {
                if (option.shippingCostType === 'FREE') return 0;

                const value = option.shippingCost?.value;
                return value == null ? null : Number(value);
            })
            .filter(value => value !== null && Number.isFinite(value));

        // Do not assume missing postage means free postage.
        if (shippingCosts.length === 0) continue;

        const shipping = Math.min(...shippingCosts);
        const total = price + shipping;

        if (!results[label] || total < results[label].totalPrice) {
            results[label] = {
                ean,
                condition: label,
                itemPrice: price,
                postage: shipping,
                totalPrice: Number(total.toFixed(2)),
                currency: item.price.currency,
                title: item.title,
                url: item.itemWebUrl
            };
        }
    }

    return results;
}

app.post('/prices', async (req, res) => {
    try {
        const eans = req.body.eans;

        if (!Array.isArray(eans) || eans.length === 0) {
            return res.status(400).json({
                error: 'Send a non-empty eans array.'
            });
        }

        if (eans.length > 50) {
            return res.status(400).json({
                error: 'Send no more than 50 EANs per request.'
            });
        }

        if (!eans.every(ean =>
            /^\d{8,14}$/.test(String(ean).trim())
        )) {
            return res.status(400).json({
                error: 'Each EAN must contain 8 to 14 digits.'
            });
        }

        const token = await getEbayAccessToken();
        const output = {};

        for (const rawEan of eans) {
            const ean = String(rawEan).trim();
            output[ean] = await findLowestPrices(ean, token);
        }

        return res.json(output);
    } catch (error) {
        console.error('PRICE CHECK ERROR:', error.message);
        return res.status(502).json({
            error: 'Price lookup failed. Check Render logs.'
        });
    }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log('Notification service started.');
});

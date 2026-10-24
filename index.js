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
    const headers = {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
        'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=GB'
    };

    const results = {};
    for (const label of Object.values(CONDITION_LABELS)) {
        results[label] = null;
    }

    const seenItemIds = new Set();
    const pageSize = 200;
    const maxOffset = 10000;
    let offset = 0;

    // Browse API sorts by item price, not delivered price. We therefore
    // inspect postage and compare item + postage before choosing a winner.
    while (offset < maxOffset) {
        const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
        url.searchParams.set('gtin', ean);
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(offset));
        url.searchParams.set('sort', 'price');
        url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');

        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`eBay search failed for EAN ${ean} at offset ${offset}: ${response.status}`);
        }

        const data = await response.json();
        const items = data.itemSummaries || [];
        if (items.length === 0) break;

        // Process in small batches to avoid making hundreds of requests at once.
        const candidates = items.filter(item => {
            const label = CONDITION_LABELS[Number(item.conditionId)];
            const itemId = item.itemId;
            const price = Number(item.price?.value);
            if (!label || !itemId || !Number.isFinite(price) || seenItemIds.has(itemId)) {
                return false;
            }
            seenItemIds.add(itemId);

            // Since item prices are sorted ascending and postage cannot be
            // negative, an item price at/above our delivered-price winner cannot beat it.
            const current = results[label];
            return !current || price < current.totalPrice;
        });

        const batchSize = 8;
        for (let i = 0; i < candidates.length; i += batchSize) {
            const batch = candidates.slice(i, i + batchSize);
            await Promise.all(batch.map(async item => {
                const label = CONDITION_LABELS[Number(item.conditionId)];
                const price = Number(item.price?.value);
                const current = results[label];
                if (current && price >= current.totalPrice) return;

                try {
                    const itemResponse = await fetch(
                        `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(item.itemId)}`,
                        { headers }
                    );
                    if (!itemResponse.ok) return;

                    const details = await itemResponse.json();
                    const shippingOptions = details.shippingOptions || [];
                    const shippingCosts = shippingOptions
                        .map(option => {
                            if (option.shippingCostType === 'FREE') return 0;
                            const value = option.shippingCost?.value;
                            return value == null ? null : Number(value);
                        })
                        .filter(value => value !== null && Number.isFinite(value) && value >= 0);

                    // Unknown postage is not treated as free.
                    if (shippingCosts.length === 0) return;

                    const shipping = Math.min(...shippingCosts);
                    const total = Number((price + shipping).toFixed(2));
                    const best = results[label];
                    if (!best || total < best.totalPrice) {
                        results[label] = {
                            ean,
                            condition: label,
                            itemPrice: price,
                            postage: shipping,
                            totalPrice: total,
                            currency: item.price.currency,
                            title: item.title,
                            url: item.itemWebUrl
                        };
                    }
                } catch (error) {
                    console.error('ITEM DETAIL LOOKUP ERROR:', item.itemId, error.message);
                }
            }));
        }

        offset += items.length;
        if (items.length < pageSize || (Number.isFinite(data.total) && offset >= data.total)) {
            break;
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

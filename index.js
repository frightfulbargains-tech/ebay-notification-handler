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

    // Search by structured GTIN AND by keyword. Some sellers do not attach
    // the EAN to eBay's structured product data, but may include it in text.
    const searches = [
        { type: 'gtin', value: ean },
        { type: 'q', value: ean }
    ];

    for (const search of searches) {
        let offset = 0;

        while (offset < maxOffset) {
            const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
            url.searchParams.set(search.type, search.value);
            url.searchParams.set('limit', String(pageSize));
            url.searchParams.set('offset', String(offset));
            url.searchParams.set('sort', 'price');
            url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');

            const response = await fetch(url, { headers });
            if (!response.ok) {
                // Keep results from the other search method if one method fails.
                console.error(`eBay ${search.type} search failed for EAN ${ean} at offset ${offset}: ${response.status}`);
                break;
            }

            const data = await response.json();
            const items = data.itemSummaries || [];
            if (items.length === 0) break;

            // Process small batches to limit simultaneous detail requests.
            const candidates = items.filter(item => {
                const label = CONDITION_LABELS[Number(item.conditionId)];
                const itemId = item.itemId;
                const price = Number(item.price?.value);
                if (!label || !itemId || !Number.isFinite(price) || seenItemIds.has(itemId)) {
                    return false;
                }
                seenItemIds.add(itemId);

                // With non-negative postage, an item price at/above the
                // current delivered-price winner cannot improve that winner.
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

                        // Missing postage is unknown, not free.
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


app.get('/csv', (req, res) => {
    res.status(200).type('html').send(\`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eBay EAN Price Checker</title>
<style>
body{font:16px system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 18px;color:#202124}
h1{font-size:1.7rem}p{line-height:1.5}form{border:1px solid #ddd;border-radius:12px;padding:22px}
input,button{font:inherit}input[type=file]{display:block;margin:18px 0}button{background:#185abc;color:#fff;border:0;border-radius:7px;padding:11px 18px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}
#status{margin-top:18px;white-space:pre-wrap}small{color:#555}
</style>
</head>
<body>
<h1>eBay EAN Price Checker</h1>
<p>Upload a CSV with an <strong>EAN</strong> column, or one EAN per row. The first column is used if there is no EAN header. Up to 50 EANs per run.</p>
<form id="form">
<label for="file"><strong>Choose input CSV</strong></label>
<input id="file" type="file" accept=".csv,text/csv" required>
<button id="run" type="submit">Check prices and download CSV</button>
<div id="status" role="status" aria-live="polite"></div>
</form>
<p><small>Report columns: EAN, Title, Condition, Item Price, Postage, Total Price, Currency, eBay URL.</small></p>
<script>
const form = document.getElementById('form');
const fileInput = document.getElementById('file');
const runButton = document.getElementById('run');
const statusBox = document.getElementById('status');

function parseFirstColumn(line) {
  const match = line.match(/^\\s*(?:"((?:[^"]|"")*)"|([^,]*))/);
  return (match ? (match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2]) : '').trim();
}
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}
function downloadCsv(rows) {
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\\r\\n') + '\\r\\n';
  const blob = new Blob(['\\uFEFF', csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ebay-price-report.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  runButton.disabled = true;
  statusBox.textContent = 'Reading EANs…';
  try {
    const lines = (await file.text()).replace(/^\\uFEFF/, '').split(/\\r?\\n/).filter(line => line.trim());
    if (!lines.length) throw new Error('The file is empty.');
    let eans = lines.map(parseFirstColumn);
    if (/^ean$/i.test(eans[0])) eans.shift();
    eans = [...new Set(eans.filter(Boolean))];
    if (!eans.length) throw new Error('No EANs found in the first column.');
    if (eans.length > 50) throw new Error('This checker accepts up to 50 unique EANs per run.');
    const invalid = eans.find(ean => !/^\\d{8,14}$/.test(ean));
    if (invalid) throw new Error('Invalid EAN "' + invalid + '". EANs must contain 8–14 digits.');
    statusBox.textContent = 'Checking ' + eans.length + ' EAN(s). This may take a while…';
    const response = await fetch('/prices', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({eans})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Price lookup failed.');
    const rows = [['EAN','Title','Condition','Item Price','Postage','Total Price','Currency','eBay URL']];
    const conditions = ['New','Like New','Very Good','Good','Acceptable'];
    for (const ean of eans) {
      for (const condition of conditions) {
        const item = data[ean] && data[ean][condition];
        rows.push([
          ean,
          item ? item.title : '',
          condition,
          item ? item.itemPrice : '',
          item ? item.postage : '',
          item ? item.totalPrice : '',
          item ? item.currency : '',
          item ? item.url : ''
        ]);
      }
    }
    downloadCsv(rows);
    statusBox.textContent = 'Finished. Downloaded a report with ' + (rows.length - 1) + ' condition rows for ' + eans.length + ' EAN(s).';
  } catch (error) {
    statusBox.textContent = 'Error: ' + error.message;
  } finally {
    runButton.disabled = false;
  }
});
</script>
</body>
</html>\`);
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log('Notification service started.');
});

// File: /netlify/functions/fetchImages.js

const fetch = require('node-fetch');
const archiver = require('archiver');

// Main handler function for the serverless endpoint
exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
    }

    const { SHOPIFY_STORE_NAME, ADMIN_API_ACCESS_TOKEN, API_VERSION = '2024-07' } = process.env;
    if (!SHOPIFY_STORE_NAME || !ADMIN_API_ACCESS_TOKEN) {
        return { statusCode: 500, body: JSON.stringify({ message: 'Server configuration error.' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const credentials = { SHOPIFY_STORE_NAME, ADMIN_API_ACCESS_TOKEN, API_VERSION };
        let orders = [];

        if (body.type === 'date') {
            orders = await getOrdersByDate(body.date, credentials);
        } else if (body.type === 'order_range') {
            orders = await getOrdersByNumberRange(body.start, body.end, credentials);
        } else {
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request type.' }) };
        }

        if (!orders.length) {
            return { statusCode: 200, body: JSON.stringify({ message: 'No unfulfilled orders found for the selected criteria.' }) };
        }

        const imageUrls = await getAllImageUrlsByQuantity(orders, credentials);
        
        if (!imageUrls.length) {
            return { statusCode: 200, body: JSON.stringify({ message: 'No product images found in these unfulfilled orders.' }) };
        }

        const zipBase64 = await createZipFromUrls(imageUrls);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `Successfully bundled ${imageUrls.length} images from unfulfilled orders.`,
                zipData: zipBase64,
                fileName: `shopify-images-${new Date().toISOString().split('T')[0]}.zip`
            })
        };

    } catch (error) {
        console.error('Error:', error);
        return { statusCode: 500, body: JSON.stringify({ message: `An internal error occurred: ${error.message}` }) };
    }
};

// --- Helper Functions ---

// Fetches unfulfilled orders for a specific date
async function getOrdersByDate(date, creds) {
    const startDate = new Date(date);
    startDate.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setUTCHours(23, 59, 59, 999);
    
    // *** MODIFIED LINE: Changed status=any to status=open ***
    const url = `https://${creds.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/${creds.API_VERSION}/orders.json?status=open&created_at_min=${startDate.toISOString()}&created_at_max=${endDate.toISOString()}&limit=250`;
    
    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': creds.ADMIN_API_ACCESS_TOKEN } });
    if (!response.ok) throw new Error(`Shopify API error: ${response.statusText}`);
    const data = await response.json();
    return data.orders || [];
}

// Fetches unfulfilled orders to find a specific number range
async function getOrdersByNumberRange(startNum, endNum, creds) {
    let allOrders = [];
    let page = 1;
    const maxPages = 15;
    while (page <= maxPages) {
        // *** MODIFIED LINE: Changed status=any to status=open ***
        const url = `https://${creds.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/${creds.API_VERSION}/orders.json?status=open&limit=250&order=created_at DESC&page=${page}`;
        
        const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': creds.ADMIN_API_ACCESS_TOKEN } });
        if (!response.ok) throw new Error(`Shopify API error: ${response.statusText}`);
        const data = await response.json();
        const ordersPage = data.orders || [];
        if (!ordersPage.length) break;
        allOrders.push(...ordersPage);
        const oldestOrderNum = parseInt(ordersPage[ordersPage.length - 1].name.replace('#', ''));
        if (oldestOrderNum < startNum) break;
        page++;
    }
    // Filter the open orders to get only those within the specified number range
    return allOrders.filter(order => {
        const orderNum = parseInt(order.name.replace('#', ''));
        return orderNum >= startNum && orderNum <= endNum;
    });
}


// --- Utility Functions (No changes below this line) ---

async function createZipFromUrls(urls) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        archive.on('error', reject);
        Promise.all(urls.map((url, i) => 
            fetch(url)
                .then(res => res.buffer())
                .then(buffer => archive.append(buffer, { name: `image-${i + 1}.jpg` }))
                .catch(e => console.error(`Could not download ${url}: ${e.message}`))
        )).then(() => archive.finalize());
    });
}

async function getAllImageUrlsByQuantity(orders, creds) {
    const finalImageUrlList = [];
    const productImageCache = new Map();
    for (const order of orders) {
        for (const item of order.line_items) {
            if (!item.product_id) continue;
            let imageUrl = '';
            if (productImageCache.has(item.product_id)) {
                imageUrl = productImageCache.get(item.product_id);
            } else {
                const url = `https://${creds.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/${creds.API_VERSION}/products/${item.product_id}.json`;
                try {
                    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': creds.ADMIN_API_ACCESS_TOKEN } });
                    if (response.ok) {
                        const { product } = await response.json();
                        if (product && product.image && product.image.src) {
                            imageUrl = product.image.src;
                            productImageCache.set(item.product.id, imageUrl);
                        } else {
                            productImageCache.set(item.product_id, null);
                        }
                    }
                } catch (e) { console.error(`Failed to fetch product ${item.product_id}:`, e); }
            }
            if (imageUrl) {
                for (let i = 0; i < item.quantity; i++) {
                    finalImageUrlList.push(imageUrl);
                }
            }
        }
    }
    return finalImageUrlList;
}
```

### **How to Update Your App**

1.  **Open Your Project Folder:** Go to the `shopify-image-app` folder on your computer.
2.  **Replace the File:** Open `netlify/functions/fetchImages.js` and replace its entire content with the code above. Save the file.
3.  **Upload to GitHub:** Go to your project's repository on GitHub. Click **Add file** > **Upload files**. Drag your updated `fetchImages.js` file into the browser.
4.  **Commit Changes:** Scroll down and click **Commit changes**.

That's it! Netlify will automatically detect the change on GitHub and re-deploy your app with the new logic. The next time you use the app, it will only process and download images for your unfulfilled orde
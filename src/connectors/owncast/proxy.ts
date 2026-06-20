import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import * as cheerio from 'cheerio';
import express from 'express';

export function setupOwncastProxy(app: express.Express, upstreamUrl: string = 'http://localhost:8080') {
    // 1. Manual API Proxy for /api/ping
    app.post('/api/ping', express.json(), async (req, res) => {
        try {
            const response = await fetch(`${upstreamUrl}/api/ping`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body)
            });
            const data = await response.json();
            res.status(response.status).json(data);
        } catch (err) {
            console.error('[Owncast API Proxy Error]', err);
            res.status(502).json({ error: 'Error proxying API to Owncast.' });
        }
    });

    // 2. Main Reverse Proxy (Intercepts HTML to inject paywall)
    app.use('/', createProxyMiddleware({
        target: upstreamUrl,
        changeOrigin: true,
        selfHandleResponse: true,
        pathFilter: (path) => {
            // Exclude what we already handled or what doesn't need interception
            if (path.startsWith('/owncast-assets/')) return false;
            if (path.startsWith('/api/')) return false;
            return true;
        },
        on: {
            proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
                const contentType = proxyRes.headers['content-type'];
                if (contentType && contentType.includes('text/html')) {
                    const html = responseBuffer.toString('utf8');
                    const $ = cheerio.load(html);

                    const cacheBuster = Date.now();
                    $('body').append(`<script src="/owncast-assets/paywall.bundle.js?v=${cacheBuster}"></script>`);

                    const modifiedHtml = $.html();
                    res.setHeader('Content-Length', Buffer.byteLength(modifiedHtml));
                    return modifiedHtml;
                }
                return responseBuffer;
            }),
            error: (err) => {
                console.error('[Owncast HTML Proxy Error]', err);
            }
        }
    }));
}

import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import * as cheerio from 'cheerio';
import express from 'express';

export function setupOwncastProxy(app: express.Express, upstreamUrl: string = 'http://localhost:8080') {
    // The Magic Reverse Proxy (Catch-all)
    // Proxies everything to the Owncast instance EXCEPT our own API routes and assets
    app.use('/', createProxyMiddleware({
        target: upstreamUrl,
        changeOrigin: true,
        selfHandleResponse: true, // We will handle the response to inject HTML
        pathFilter: (path) => {
            // Block ALL /api/ routes from being proxied — they must be handled by Express
            // This prevents the proxy from consuming browser connections on /api/ping etc.
            if (path.startsWith('/api/')) return false;
            if (path.startsWith('/owncast-assets/')) return false;
            return true;
        },
        on: {
            proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
                // If it's an HTML page (like the main stream page), we inject our paywall!
                if (proxyRes.headers['content-type'] && proxyRes.headers['content-type'].includes('text/html')) {
                    const html = responseBuffer.toString('utf8');
                    const $ = cheerio.load(html);

                    // Inject our Arc Paywall script at the end of the body
                    const cacheBuster = Date.now();
                    $('body').append(`<script src="/owncast-assets/paywall.js?v=${cacheBuster}"></script>`);

                    return $.html();
                }

                // For images, videos, and other assets, just pass them through unmodified
                return responseBuffer;
            }),
            error: (err, req, res) => {
                console.error('[Owncast Proxy Error]', err);
                (res as express.Response).status(502).send('Error proxying to Owncast. Is it running on port 8080?');
            }
        }
    }));
}

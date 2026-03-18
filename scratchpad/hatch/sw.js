self.oninstall = event => event.waitUntil(self.skipWaiting());
self.onactivate = event => event.waitUntil(self.clients.claim());

const S = self.evalsandboxperclientv1 = { 
    errors: Object.assign(new Array(10001).fill(null), { 0: 0 }),
    routeMap: {},
    status: { locked: false }, 
    ...self.evalsandboxperclientv1 
};

const trap = (fn, ev) => { 
    try { 
        let p = fn(ev); 
        if (p?.catch) p.catch(x => S.errors[S.errors[0]++ % 10000 + 1] = x.stack || String(x)); 
        return p; 
    } catch (x) { 
        S.errors[S.errors[0]++ % 10000 + 1] = x.stack || String(x); 
    } 
};

const manifest = event => {
    if (S[event.type]) {
        let prom = trap(S[event.type], event);
        if (prom) event.waitUntil(prom);
    }
};
self.onpush = self.onsync = self.onnotificationclick = self.onnotificationclose = manifest;

self.onmessage = async event => {
    let ES = event.data?.evalsandboxperclientv1;
    if (!ES) return;

    let cid = event.source.id;
    let curl = new URL(event.source.url).pathname;

    let follow = ES.status?.multilinkfollow ?? S[cid]?.status?.multilinkfollow ?? S[curl]?.status?.multilinkfollow ?? 0;
    let PTR = follow ? cid : curl;

    let C = S[PTR] ??= {};
    let ESS = C.status ??= {};

    ESS.acknowledgement = ES.status?.acknowledgement ?? ESS.acknowledgement ?? null;
    ESS.persistence     = ES.status?.persistence     ?? ESS.persistence     ?? 0;
    ESS.multilinkfollow = ES.status?.multilinkfollow ?? ESS.multilinkfollow ?? 0;
    ESS.wakelock        = ES.status?.wakelock        ?? ESS.wakelock        ?? 0;
    ESS.revivingpayload = ES.status?.revivingpayload ?? ESS.revivingpayload ?? 0;
    ESS.haveidied       = ES.status?.haveidied       ?? ESS.haveidied       ?? 1;
    ESS.clientid        = ES.status?.clientid        ?? ESS.clientid        ?? cid;
    ESS.clienturl       = ES.status?.clienturl       ?? ESS.clienturl       ?? curl;

    for (let key in ES) {
        if (key !== 'status') C[key] = ES[key] ?? C[key];
    }

    ES.status = ESS;     
    S.routeMap[ESS.clientid] = ESS.clienturl;

    if (ES.payload !== undefined) {
        C.payload = ES.payload;
        ESS.haveidied = 1;
    } else if (ESS.revivingpayload && !C.fn && ESS.persistence) {
        let diskRecord = await (await caches.open('S')).match(ESS.clienturl);
        if (diskRecord) {
            C.payload = await diskRecord.text();
            ESS.haveidied = 1;
        }
    }

    if (C.payload && (!C.fn || ES.payload !== undefined)) {
        C.fn = new (async()=>{}).constructor('event', C.payload);
        trap(C.fn, event);
        ESS.haveidied = 0;

        if (ESS.persistence && ES.payload !== undefined) {
            await (await caches.open('S')).put(ESS.clienturl, new Response(C.payload));
        }
        ESS.acknowledgement = S.errors[0] === ES.errors?.[0]; // Ack is true if errors didn't increase
        if (!ESS.acknowledgement) ES.last_error = S.errors[(S.errors[0] === 0 ? 1 : S.errors[0]) % 10000 || 10000];
    }

    if (ES.history) ES.errors = S.errors;
    event.source.postMessage({ evalsandboxperclientv1: ES });

    if (ESS.wakelock && !S.status.locked) {
        S.status.locked = true;
        event.waitUntil((async () => {
            while (await self.clients.matchAll().then(c => c.length > 0)) {
                await new Promise(r => setTimeout(r, 10000));
            }
            S.routeMap = {}; 
            S.status.locked = false;
        })());
    }
};

self.onfetch = event => {
    let routeFallback = new URL(event.request.mode === 'navigate' ? event.request.url : (event.request.referrer || event.request.url)).pathname;
    let PTR = S[event.clientId] ? event.clientId : (S.routeMap[event.clientId] || routeFallback);

    if (S[PTR] && S[PTR].fn) {
        trap(S[PTR].fn, event);
    } else {
        event.respondWith((async () => {
            let trueRoute = PTR;
            if (!S.routeMap[event.clientId] && event.clientId) {
                let activeClient = await self.clients.get(event.clientId);
                if (activeClient) {
                    trueRoute = new URL(activeClient.url).pathname;
                    S.routeMap[event.clientId] = trueRoute;
                }
            }
            
            let diskRecord = await (await caches.open('S')).match(trueRoute);
            
            if (diskRecord) {
                let rawCode = await diskRecord.text();
                
                S[trueRoute] ??= {};
                S[trueRoute].status ??= { persistence: 1, multilinkfollow: 0, clienturl: trueRoute };
                S[trueRoute].status.haveidied = 1;
                
                S[trueRoute].payload = rawCode;
                S[trueRoute].fn = new (async()=>{}).constructor('event', rawCode);
                
                let capturedPromise;
                let proxyEvent = new Proxy(event, {
                    get: (target, prop) => {
                        if (prop === 'respondWith') return (prom) => { capturedPromise = prom; };
                        return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
                    }
                });
                
                trap(S[trueRoute].fn, proxyEvent);
                S[trueRoute].status.haveidied = 0;
                
                if (capturedPromise) return await capturedPromise;
            }
            
            return fetch(event.request);
        })().catch(() => fetch(event.request)));
    }
};

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('node:crypto');

if (!getApps().length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is missing.');
  let sa;
  try { sa = JSON.parse(raw); } catch (_) { sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  initializeApp({ credential: cert(sa), projectId: sa.project_id });
}
const db = getFirestore();
const resellerApiKey = { value: () => process.env.RESELLER_API_KEY };
const resellerMasterKey = { value: () => process.env.RESELLER_MASTER_KEY };
const famGatewayApiKey = { value: () => process.env.FAMGATEWAY_API_KEY };
const resellerSecrets = [resellerApiKey, resellerMasterKey];
const apiSecrets = [...resellerSecrets, famGatewayApiKey];
const RESELLER_API_URL = 'https://inradminpanels.site/api/reseller_v1.php';
const FAMGATEWAY_BASE_URL = 'https://famgateway.in';

const response = (res, status, body) => res.status(status).json(body);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const number = (v, name, min = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw fail(`Invalid ${name}.`);
  return n;
};

function moneyCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

async function famGatewayJson(url, options = {}) {
  let result;
  try {
    result = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch (_) {
    throw fail('FamGateway could not be reached. Please try again.', 502);
  }
  const contentType = result.headers.get('content-type') || '';
  const responseText = await result.text();
  let payload = null;
  if (contentType.includes('application/json')) {
    try { payload = JSON.parse(responseText); } catch (_) {}
  }
  if (result.status === 408 && payload?.status === 'expired') return payload;
  if (!result.ok || !payload || typeof payload !== 'object') {
    console.error('FamGateway returned a non-JSON or unsuccessful response:', result.status, contentType);
    throw fail('FamGateway payment service returned an invalid response. Please try again later.', 502);
  }
  return payload;
}

function gatewayHostedUrl(value, fallback) {
  const candidate = String(value || fallback || '');
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !['famgateway.in', 'www.famgateway.in'].includes(url.hostname))
      throw new Error('invalid host');
    return url.href;
  } catch (_) {
    throw fail('FamGateway returned an invalid checkout link.', 502);
  }
}

function normalizeUtr(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
}

async function createFamGatewayOrder(user, requestedAmount) {
  const apiKey = famGatewayApiKey.value();
  if (!apiKey) throw fail('FamGateway API key is not configured on the local server.', 503);
  const amountCents = moneyCents(requestedAmount);
  if (!Number.isInteger(amountCents) || amountCents < 1000 || amountCents > 5000000)
    throw fail('Enter a deposit amount from ₹10.00 to ₹50,000.00.');
  const upstream = await famGatewayJson(FAMGATEWAY_BASE_URL + '/api/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ amount: amountCents / 100 })
  });
  const data = upstream.data || upstream;
  const orderId = String(data.order_id || '').trim();
  if (upstream.status !== 'success' || !/^[A-Za-z0-9_-]{3,100}$/.test(orderId))
    throw fail('FamGateway did not create a valid payment order.', 502);
  const providerAmountCents = moneyCents(data.amount ?? requestedAmount);
  const payableAmountCents = moneyCents(data.payable_amount ?? data.amount ?? requestedAmount);
  if (providerAmountCents !== amountCents || !Number.isInteger(payableAmountCents) || payableAmountCents <= 0)
    throw fail('FamGateway returned an unexpected payment amount.', 502);
  const qrUrl = gatewayHostedUrl(data.qr_url, FAMGATEWAY_BASE_URL + '/api/qr-image.php?order_id=' + encodeURIComponent(orderId));
  const checkoutUrl = gatewayHostedUrl(data.checkout_url, FAMGATEWAY_BASE_URL + '/pay.php?order_id=' + encodeURIComponent(orderId));
  const upiIntent = String(data.upi_intent || '');
  if (upiIntent && !/^upi:\/\/pay\?/i.test(upiIntent)) throw fail('FamGateway returned an invalid UPI link.', 502);
  const createdAt = Date.now();
  const expiresAt = createdAt + 5 * 60 * 1000;
  const orderRef = db.collection('paymentOrders').doc(orderId);
  try {
    await orderRef.create({
      uid: user.uid, order_id: orderId, status: 'pending',
      requested_amount: amountCents / 100, payable_amount: payableAmountCents / 100,
      amount_cents: amountCents, payable_amount_cents: payableAmountCents,
      qr_url: qrUrl, checkout_url: checkoutUrl, upi_intent: upiIntent,
      created_at: new Date(createdAt).toISOString(), expires_at: new Date(expiresAt).toISOString(),
      expires_at_ms: expiresAt
    });
  } catch (_) {
    throw fail('Could not save the payment order. Please create a new one.', 503);
  }
  return {
    order_id: orderId, amount: amountCents / 100, payable_amount: payableAmountCents / 100,
    qr_url: qrUrl, checkout_url: checkoutUrl, upi_intent: upiIntent,
    expires_at: new Date(expiresAt).toISOString()
  };
}

async function verifyFamGatewayOrder(order) {
  const publicStatus = await famGatewayJson(FAMGATEWAY_BASE_URL + '/api/checkout-status.php?order_id=' + encodeURIComponent(order.order_id));
  if (publicStatus.status === 'expired') return { status: 'expired' };
  if (publicStatus.status !== 'success') return { status: 'pending' };
  const apiKey = famGatewayApiKey.value();
  if (!apiKey) throw fail('FamGateway API key is not configured on the local server.', 503);
  const verifyUrl = FAMGATEWAY_BASE_URL + '/api/verify-order.php?order_id=' + encodeURIComponent(order.order_id);
  const verified = await famGatewayJson(verifyUrl, { headers: { 'X-Api-Key': apiKey } });
  if (verified.status === 'expired') return { status: 'expired' };
  const details = verified.data || verified;
  if (verified.status !== 'success' && details.status !== 'success') return { status: 'pending' };
  const verifiedOrderId = String(details.order_id || verified.order_id || '');
  const verifiedAmountCents = moneyCents(details.payable_amount ?? details.amount ?? verified.payable_amount ?? verified.amount);
  if (verifiedOrderId !== order.order_id || verifiedAmountCents !== Number(order.payable_amount_cents))
    throw fail('FamGateway payment details did not match this order.', 409);
  return {
    status: 'success', utr: normalizeUtr(details.utr || verified.utr),
    transaction_id: String(details.transaction_id || verified.transaction_id || ''),
    amount_cents: verifiedAmountCents
  };
}

async function creditVerifiedFamGatewayOrder(orderRef, verified) {
  const normalizedUtr = normalizeUtr(verified.utr);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) throw fail('Payment order not found.', 404);
  const order = orderSnapshot.data();
  const userRef = db.collection('users').doc(order.uid);
  const transactionRef = db.collection('transactions').doc('fam_' + order.order_id);
  const utrRef = normalizedUtr ? db.collection('famGatewayUtrs').doc('utr_' + normalizedUtr) : null;
  return db.runTransaction(async tx => {
    const [latestOrder, userSnapshot] = await Promise.all([tx.get(orderRef), tx.get(userRef)]);
    if (!latestOrder.exists) throw fail('Payment order not found.', 404);
    const current = latestOrder.data();
    if (current.status === 'success') return { status: 'success', credited: true, amount: current.payable_amount };
    if (!userSnapshot.exists) throw fail('Account profile is not initialized.', 401);
    let utrSnapshot = null;
    if (utrRef) utrSnapshot = await tx.get(utrRef);
    if (utrSnapshot?.exists && utrSnapshot.data().order_id !== current.order_id)
      throw fail('This UTR was already used for another payment.', 409);
    const amountCents = Number(current.payable_amount_cents);
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents !== verified.amount_cents)
      throw fail('Verified payment amount did not match the saved order.', 409);
    const nextBalanceCents = moneyCents(userSnapshot.data().balance || 0) + amountCents;
    const paidAt = new Date().toISOString();
    tx.update(userRef, { balance: nextBalanceCents / 100 });
    tx.set(transactionRef, {
      uid: current.uid, type: 'Deposit', detail: 'FamGateway UPI deposit · ' + current.order_id,
      amount: amountCents / 100, status: 'success', order_id: current.order_id,
      transaction_id: verified.transaction_id || null, utr: normalizedUtr || null, created: paidAt
    });
    tx.set(orderRef, {
      status: 'success', utr: normalizedUtr || null, transaction_id: verified.transaction_id || null,
      paid_at: paidAt, updated_at: paidAt
    }, { merge: true });
    if (utrRef) tx.create(utrRef, { order_id: current.order_id, uid: current.uid, created_at: paidAt });
    return { status: 'success', credited: true, amount: amountCents / 100 };
  });
}

async function markFamGatewayExpired(orderRef) {
  await db.runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (snap.exists && snap.data().status !== 'success')
      tx.set(orderRef, { status: 'expired', updated_at: new Date().toISOString() }, { merge: true });
  });
}

async function getOwnedFamGatewayOrder(user, rawOrderId) {
  const orderId = String(rawOrderId || '').trim();
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(orderId)) throw fail('Enter a valid payment order ID.');
  const ref = db.collection('paymentOrders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== user.uid) throw fail('Payment order not found.', 404);
  return { ref, data: snap.data() };
}

async function requireUser(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) throw fail('Sign in required.', 401);
  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    const snap = await db.collection('users').doc(decoded.uid).get();
    if (!snap.exists) throw fail('Account profile is not initialized.', 401);
    const data = snap.data();
    return { uid: decoded.uid, ...data, role: normalizeRole(data.role), email: data.email || decoded.email || '', username: data.username || String(data.email || decoded.email || '').split('@')[0].toLowerCase() };
  } catch (e) {
    if (e.status) throw e;
    throw fail('Invalid or expired sign-in. Please log in again.', 401);
  }
}

function normalizeRole(role) {
  const normalized = String(role || 'USER').trim().toUpperCase();
  return normalized === 'ADMIN' || normalized === 'RESELLER' ? normalized : 'USER';
}

function requireAdmin(user) {
  if (normalizeRole(user.role) !== 'ADMIN') throw fail('Admin access required.', 403);
}

async function findUserByUsername(username) {
  const normalized = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (normalized.length < 2 || normalized.length > 64) throw fail('Enter a valid username.');
  const users = await db.collection('users').get();
  const matches = users.docs.filter(doc => {
    const data = doc.data();
    const current = String(data.username || String(data.email || '').split('@')[0]).trim().replace(/^@/, '').toLowerCase();
    return current === normalized;
  });
  if (!matches.length) throw fail('No account was found with that username.', 404);
  if (matches.length > 1) throw fail('That username matches multiple accounts. Contact an administrator.', 409);
  return matches[0];
}

async function list(query, limit = 500) {
  const snap = await query.limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function resellerMessage(status, message = '') {
  const m = String(message).toLowerCase();
  if (status === 401 || m.includes('master key') || m.includes('api key')) return 'Reseller API authorization failed.';
  if (status === 402 || m.includes('insufficient balance')) return 'Reseller balance is too low to complete this purchase.';
  if (status === 403) return 'Reseller API access is disabled.';
  if (status === 404) return 'The selected reseller product or plan was not found.';
  if (status === 409 || m.includes('out of stock') || m.includes('duplicate')) return 'This plan is out of stock or a purchase is already processing.';
  if (status === 422 || m.includes('android') || m.includes('device')) return 'The selected plan needs valid device details.';
  if (status === 429) return 'Too many requests. Please wait and try again.';
  if (status === 503 || status >= 500) return 'The reseller service is temporarily unavailable.';
  if (m.includes('insufficient balance')) return 'Reseller balance is too low to complete this purchase.';
  if (m.includes('out of stock')) return 'This plan is currently out of stock.';
  if (m.includes('duration') || m.includes('plan')) return 'The selected plan is no longer available.';
  return 'The reseller service could not complete the request.';
}

async function resellerRequest(action, fields = {}) {
  const apiKey = resellerApiKey.value();
  if (!apiKey) throw fail('Reseller API is not configured on the local server.', 503);
  const masterKey = resellerMasterKey.value();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (masterKey) headers['x-master-key'] = masterKey;
  let upstream;
  try {
    upstream = await fetch(RESELLER_API_URL, {
      method: 'POST', headers,
      body: new URLSearchParams({ api_key: apiKey, action, ...Object.fromEntries(Object.entries(fields).map(([k,v]) => [k, String(v)])) }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (_) {
    throw fail('The reseller service could not be reached. Please try again.', 503);
  }
  let result;
  try { result = await upstream.json(); }
  catch (_) { throw fail('The reseller service returned an invalid response.', 502); }
  if (!upstream.ok || result?.status !== 'success') {
    const status = upstream.status || 502;
    throw fail(resellerMessage(status, result?.msg), status >= 400 ? status : 502);
  }
  return result;
}

const truthy = value => { if (value === true) return true; if (typeof value === 'number') return Number.isFinite(value) && value > 0; const text = String(value ?? '').trim().toLowerCase(); if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) > 0; return ['true','yes','y','available','in stock','instock','unlimited','green','active','enabled','online'].includes(text); };
function durationDays(value) {
  const m = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(h|hr|hour|hours|d|day|days|w|week|weeks|m|month|months|y|year|years)/i);
  if (!m) return 0;
  const n = Number(m[1]), u = m[2].toLowerCase();
  if (u.startsWith('h')) return n / 24;
  if (u.startsWith('w')) return n * 7;
  if (u.startsWith('m')) return n * 30;
  if (u.startsWith('y')) return n * 365;
  return n;
}
function normalizePlans(payload) {
  const products = Array.isArray(payload) ? payload : payload?.products || payload?.plans || payload?.items;
  if (!Array.isArray(products)) throw fail('Reseller catalog response was not recognized.', 502);
  const plans = [];
  for (const product of products) {
    const productId = String(product.product_id ?? product.pid ?? product.id ?? '');
    const name = String(product.product_name ?? product.name ?? product.title ?? '').trim();
    const durations = Array.isArray(product.durations) && product.durations.length ? product.durations : [product];
    for (const plan of durations) {
      const planId = String(plan.plan_id ?? plan.planId ?? plan.id ?? product.plan_id ?? '').replace(/^#/, '');
      if (!planId || !productId || !name) continue;
      const duration = String(plan.duration ?? plan.label ?? product.duration ?? '').trim();
      const cost = Number(plan.reseller_price ?? plan.api_price ?? plan.price ?? product.reseller_price ?? product.api_price ?? product.price ?? 0);
      const retailRaw = plan.website_price ?? plan.normal_price ?? plan.retail_price ?? product.website_price ?? product.normal_price ?? product.retail_price;
      const retailPrice = retailRaw == null || retailRaw === '' ? null : Number(retailRaw);
      const productLive = product.status == null || truthy(product.status);
      const available = productLive && !truthy(product.maintenance) && (plan.in_stock == null || truthy(plan.in_stock));
      plans.push({
        plan_id: planId, product_id: productId, name, subtitle: String(product.subtitle ?? product.description ?? ''),
        duration, days: durationDays(duration), api_price: Number.isFinite(cost) ? cost : 0,
        default_price: Number.isFinite(retailPrice) && retailPrice > 0 ? retailPrice : null,
        image: String(product.image ?? product.poster ?? ''), video: String(product.video ?? ''),
        requires_android_id: truthy(product.require_android_id ?? plan.require_android_id), available
      });
    }
  }
  if (!plans.length) throw fail('The reseller catalog did not contain any usable plans.', 502);
  return plans;
}

async function syncResellerCatalog() {
  const settingsRef = db.collection('settings').doc('resellerCatalog');
  const settings = await settingsRef.get();
  if (settings.exists && settings.data().enabled === false) return { status: 'disabled', imported: 0, updated: 0, unavailable: 0, totalPlans: 0 };
  const lockRef = db.collection('settings').doc('resellerSyncLock');
  const metaRef = settingsRef;
  const owner = randomUUID(), now = Date.now();
  await db.runTransaction(async tx => {
    const current = await tx.get(lockRef);
    if (current.exists && Number(current.data().lockedUntil || 0) > now) throw fail('Product synchronization is already running.', 409);
    tx.set(lockRef, { owner, lockedUntil: now + 120000 });
  });
  try {
    const responseData = await resellerRequest('products');
    const plans = normalizePlans(responseData.data);
    const currentSnap = await db.collection('products').where('source', '==', 'reseller_api').get();
    const existing = new Map(currentSnap.docs.map(d => [String(d.data().plan_id), { ref: d.ref, data: d.data() }]));
    const seen = new Set(), batch = db.batch();
    let imported = 0, updated = 0, unavailable = 0;
    for (const [displayOrder, p] of plans.entries()) {
      const id = `reseller_${p.plan_id}`, ref = db.collection('products').doc(id);
      const old = existing.get(p.plan_id)?.data || {};
      seen.add(p.plan_id);
      if (old.plan_id) updated++; else imported++;
      if (!p.available) unavailable++;
      const hasCustomPrice = old.price_source === 'custom' && Number.isFinite(Number(old.price)) && Number(old.price) > 0;
      const price = hasCustomPrice ? Number(old.price) : null;
      const hasCustomResellerPrice = old.reseller_price_source === 'custom' && Number.isFinite(Number(old.reseller_price)) && Number(old.reseller_price) > 0;
      const resellerPrice = hasCustomResellerPrice ? Number(old.reseller_price) : null;
      const storefrontAdded = old.storefront_added === true;
      const visible = storefrontAdded && old.visible !== false;
      batch.set(ref, {
        source: 'reseller_api', plan_id: p.plan_id, product_id: p.product_id,
        api_name: p.name, name: old.custom_name ? old.name : p.name,
        subtitle: p.subtitle, duration: p.duration, days: p.days,
        api_price: p.api_price, price, price_source: hasCustomPrice ? 'custom' : 'unconfigured',
        reseller_price: resellerPrice, reseller_price_source: hasCustomResellerPrice ? 'custom' : 'unconfigured',
        image: old.image_source === 'custom' ? old.image : p.image, api_image: p.image,
        image_source: old.image_source || 'api_default', video: p.video,
        requires_android_id: p.requires_android_id,
        api_available: p.available, storefront_added: storefrontAdded, visible, active: p.available && visible && (Number(price || 0) > 0 || Number(resellerPrice || 0) > 0),
        category: old.category ?? 'API Imported', description: old.custom_description ? old.description : p.subtitle,
        display_order: old.display_order ?? displayOrder,
        synced_at: new Date().toISOString(), updated: new Date().toISOString()
      }, { merge: true });
    }
    for (const doc of currentSnap.docs) {
      const old = doc.data();
      if (!seen.has(String(old.plan_id))) {
        unavailable++;
        batch.set(doc.ref, { api_available: false, active: false, synced_at: new Date().toISOString() }, { merge: true });
      }
    }
    await batch.commit();
    const syncedAt = new Date().toISOString();
    const summary = { status: 'success', imported, updated, unavailable, totalPlans: plans.length, lastSync: syncedAt, nextSync: new Date(Date.now() + 10 * 60000).toISOString() };
    await metaRef.set(summary, { merge: true });
    await db.collection('resellerSyncLogs').add({ ...summary, created: syncedAt });
    return summary;
  } catch (e) {
    const message = e.status ? e.message : 'Reseller catalog synchronization failed.';
    const failedAt = new Date().toISOString();
    await metaRef.set({ status: 'error', lastError: message, lastAttempt: failedAt }, { merge: true }).catch(() => {});
    await db.collection('resellerSyncLogs').add({ status: 'error', message, created: failedAt }).catch(() => {});
    throw e;
  } finally {
    await db.runTransaction(async tx => {
      const current = await tx.get(lockRef);
      if (current.exists && current.data().owner === owner) tx.delete(lockRef);
    }).catch(() => {});
  }
}

async function ensureResellerCatalog() {
  if (!resellerApiKey.value()) return;
  const meta = await db.collection('settings').doc('resellerCatalog').get();
  if (meta.exists && meta.data().enabled === false) return;
  const last = meta.exists ? Date.parse(meta.data().lastSync || '') : 0;
  if (!last || Date.now() - last >= 10 * 60000) {
    try { await syncResellerCatalog(); }
    catch (e) { if (e.status !== 409 && !meta.exists) throw e; }
  }
}

async function performResellerPurchase(user, request) {
  const settings = await db.collection('settings').doc('resellerCatalog').get();
  if (settings.exists && settings.data().enabled === false) throw fail('Reseller purchases are temporarily disabled.', 503);
  const productId = String(request?.product_id || '');
  const productSnap = await db.collection('products').doc(productId).get();
  if (!productSnap.exists) throw fail('Selected product was not found.', 404);
  const product = productSnap.data();
  if (product.source !== 'reseller_api') throw fail('This product has no connected reseller plan.', 503);
  if (!product.api_available || !product.active) throw fail('This reseller plan is currently unavailable.', 409);
  if (product.requires_android_id && !String(request?.android_id || '').trim()) throw fail('This plan requires an Android ID.', 422);
  const requestId = String(request?.request_id || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) || randomUUID();
  const requestRef = db.collection('purchaseRequests').doc(`${user.uid}_${requestId}`);
  const lockRef = db.collection('purchaseLocks').doc(`${user.uid}_${product.plan_id}`);
  const userRef = db.collection('users').doc(user.uid);
  const transactionRef = db.collection('transactions').doc(`${user.uid}_${requestId}`);
  const amount = Number(user.role === 'RESELLER' && user.reseller_pricing_enabled !== false ? product.reseller_price : product.price);
  if (!Number.isFinite(amount) || amount <= 0) throw fail('This plan is not priced for your account yet. Please contact support.', 409);
  const now = Date.now();
  const balanceResult = await resellerRequest('balance');
  const resellerBalanceData = balanceResult.data || balanceResult;
  const resellerBalance = Number(resellerBalanceData.balance ?? resellerBalanceData.current_balance);
  if (!Number.isFinite(resellerBalance)) throw fail('The reseller balance response could not be verified.', 502);
  if (resellerBalance < Number(product.api_price || 0)) throw fail('Reseller balance is too low to complete this purchase.', 402);
  const checkedAt = new Date().toISOString();
  await db.collection('settings').doc('resellerCatalog').set({
    connectionStatus: 'connected', balance: resellerBalance,
    lowBalance: truthy(resellerBalanceData.low_balance ?? resellerBalanceData.lowBalance), lastBalanceCheck: checkedAt
  }, { merge: true });
  await db.runTransaction(async tx => {
    const [requestSnap, lockSnap, userSnap] = await Promise.all([tx.get(requestRef), tx.get(lockRef), tx.get(userRef)]);
    if (!userSnap.exists) throw fail('Account profile is not initialized.', 401);
    if (requestSnap.exists && ['pending', 'pending_review'].includes(requestSnap.data().status)) throw fail('This purchase is still being verified. Please contact support before trying again.', 409);
    if (requestSnap.exists && requestSnap.data().status === 'success') throw fail('This purchase already completed. Check My Keys.', 409);
    if (lockSnap.exists && ['processing', 'pending_review'].includes(lockSnap.data().status)) throw fail('A purchase for this plan is already processing or under review.', 409);
    const balance = Number(userSnap.data().balance || 0);
    if (balance < amount) throw fail('Your wallet balance is too low.', 402);
    tx.update(userRef, { balance: balance - amount });
    tx.set(lockRef, { requestId, status: 'processing', created: new Date().toISOString() });
    tx.set(requestRef, { uid: user.uid, product_id: productId, plan_id: product.plan_id, status: 'pending', transaction_id: transactionRef.id, created: new Date().toISOString() });
    tx.set(transactionRef, { uid: user.uid, type: 'Purchase', detail: `${product.name} - ${product.duration}`, product_id: productId, plan_id: product.plan_id, product_name: product.name, duration: product.duration, amount: -amount, status: 'pending', created: new Date().toISOString() });
  });
  let upstream;
  try {
    upstream = await resellerRequest('buy', {
      plan_id: product.plan_id,
      ...(product.requires_android_id ? { android_id: String(request.android_id).trim() } : {})
    });
  } catch (e) {
    if (e.status && e.status < 500) {
      await db.runTransaction(async tx => {
        const [u, tr] = await Promise.all([tx.get(userRef), tx.get(transactionRef)]);
        if (u.exists && tr.exists && tr.data().status === 'pending') {
          tx.update(userRef, { balance: Number(u.data().balance || 0) + amount });
          tx.update(transactionRef, { status: 'failed', failure: e.message, updated: new Date().toISOString() });
          tx.set(requestRef, { status: 'failed', failure: e.message }, { merge: true });
          tx.delete(lockRef);
        }
      });
    } else {
      await transactionRef.set({ status: 'pending_review', updated: new Date().toISOString() }, { merge: true });
      await requestRef.set({ status: 'pending_review' }, { merge: true });
      await lockRef.set({ status: 'pending_review', updated: new Date().toISOString() }, { merge: true });
    }
    throw e;
  }
  const data = upstream.data || {};
  const key = String(data.key || upstream.key || '').trim();
  if (upstream.status !== 'success' || !key || key.length > 500) {
    await transactionRef.set({ status: 'pending_review', updated: new Date().toISOString() }, { merge: true });
    await requestRef.set({ status: 'pending_review' }, { merge: true });
    await lockRef.set({ status: 'pending_review', updated: new Date().toISOString() }, { merge: true });
    throw fail('The reseller response could not be verified. Your purchase is under review; no key was delivered.', 502);
  }
  const purchasedAt = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.collection('keys').doc(transactionRef.id), {
    uid: user.uid, name: product.name, key, created: purchasedAt,
    expires: null, revoked: false, product_id: productId, plan_id: product.plan_id, duration: product.duration
  });
  batch.set(transactionRef, { status: 'success', api_reference: String(data.product_id || product.product_id), api_key_recorded: true, updated: purchasedAt }, { merge: true });
  batch.set(requestRef, { status: 'success', completed: purchasedAt }, { merge: true });
  batch.delete(lockRef);
  await batch.commit();
  return { status: 'success', key, transaction_id: transactionRef.id };
}

async function api(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const path = (req.path || '/').replace(/^\/api\/?/, '').replace(/\/$/, '');
  try {
    if (path === 'register' && req.method === 'POST') {
      const decoded = await getAuth().verifyIdToken((req.get('authorization') || '').replace(/^Bearer /i, ''));
      const name = String(req.body?.name || '').trim().slice(0, 80);
      if (!name) throw fail('Name is required.');
      const ref = db.collection('users').doc(decoded.uid);
      const username = String(decoded.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32) || `user_${decoded.uid.slice(0, 8)}`;
      await db.runTransaction(async tx => {
        const old = await tx.get(ref);
        if (!old.exists) tx.set(ref, {
          name, email: decoded.email || '', username, role: 'USER', balance: 0,
          created: new Date().toISOString()
        });
      });
      return response(res, 200, { ok: true });
    }

    const user = await requireUser(req);
    if (path === 'me' && req.method === 'GET') return response(res, 200, user);
    if (path === 'profile/settings' && req.method === 'GET') {
      const authUser = await getAuth().getUser(user.uid);
      const userRef = db.collection('users').doc(user.uid), storedProfile = await userRef.get();
      if (!storedProfile.data()?.username) await userRef.update({ username: user.username, updated: new Date().toISOString() });
      return response(res, 200, {
        uid: user.uid, name: user.name || authUser.displayName || '', username: user.username,
        email: user.email || authUser.email || '', balance: Number(user.balance || 0), role: user.role || 'USER',
        created: user.created || authUser.metadata.creationTime || '', photo: user.photo_data || authUser.photoURL || '',
        emailVerified: Boolean(authUser.emailVerified), lastSignIn: authUser.metadata.lastSignInTime || '',
        providers: (authUser.providerData || []).map(p => p.providerId), passwordProvider: (authUser.providerData || []).some(p => p.providerId === 'password'),
        security: { twoFactorConfigured: Boolean(authUser.multiFactor?.enrolledFactors?.length), accountDisabled: Boolean(authUser.disabled) }
      });
    }
    if (path === 'profile/update' && req.method === 'POST') {
      const name = String(req.body?.name || '').trim().slice(0, 80);
      if (name.length < 2) throw fail('Full name must be at least 2 characters.');
      const photo = req.body?.photo_data;
      if (photo != null && (typeof photo !== 'string' || photo.length > 500000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(photo))) throw fail('Profile picture must be a PNG, JPEG, or WebP image under 350 KB.');
      const patch = { name, updated: new Date().toISOString() };
      if (photo != null) patch.photo_data = photo;
      await db.collection('users').doc(user.uid).update(patch);
      try { await getAuth().updateUser(user.uid, { displayName: name }); } catch (e) { console.warn('Could not update Firebase display name:', e.message); }
      return response(res, 200, { ok: true, name });
    }
    if (path === 'products' && req.method === 'GET') {
      await ensureResellerCatalog();
      const plans = await list(db.collection('products').where('source', '==', 'reseller_api'));
      const products = plans.filter(p => p.storefront_added === true && p.visible !== false)
        .filter(p => { const price = user.role === 'RESELLER' && user.reseller_pricing_enabled !== false ? p.reseller_price : p.price; return Number.isFinite(Number(price)) && Number(price) > 0; })
        .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0)
          || String(a.api_name || a.name).localeCompare(String(b.api_name || b.name))
          || Number(a.plan_id || 0) - Number(b.plan_id || 0))
        .map(p => {
        const tierPrice = user.role === 'RESELLER' && user.reseller_pricing_enabled !== false ? p.reseller_price : p.price;
        const hasPrice = Number.isFinite(Number(tierPrice)) && Number(tierPrice) > 0;
        const { api_price, api_image, price_source, reseller_price_source, reseller_price, source, ...safe } = p;
        return { ...safe, price: hasPrice ? Number(tierPrice) : null, active: p.api_available === true && p.active === true && hasPrice };
      });
      return response(res, 200, products);
    }
    if (path === 'keys' && req.method === 'GET') {
      const keys = await list(db.collection('keys').where('uid', '==', user.uid));
      return response(res, 200, keys);
    }
    if (path === 'history' && req.method === 'GET') {
      const rows = await list(db.collection('transactions').where('uid', '==', user.uid));
      rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
      return response(res, 200, rows);
    }
    if (path === 'top-users' && req.method === 'GET') {
      const users = await list(db.collection('users').orderBy('balance', 'desc'), 10);
      return response(res, 200, users.map(({ name, role }) => ({ name, role })));
    }
    if (path === 'pay/order' && req.method === 'POST') {
      const amount = number(req.body?.amount, 'deposit amount', 10);
      if (amount > 50000) throw fail('The maximum deposit is ₹50,000.');
      return response(res, 200, await createFamGatewayOrder(user, amount));
    }
    if (path === 'pay/status' && req.method === 'GET') {
      const { ref, data: order } = await getOwnedFamGatewayOrder(user, req.query?.order_id);
      if (order.status === 'success') return response(res, 200, { status: 'success', credited: true, amount: order.payable_amount });
      if (order.status === 'expired') return response(res, 200, { status: 'expired' });
      const verified = await verifyFamGatewayOrder(order);
      if (verified.status === 'success')
        return response(res, 200, await creditVerifiedFamGatewayOrder(ref, verified));
      if (verified.status === 'expired' || Date.now() >= Number(order.expires_at_ms || 0)) {
        await markFamGatewayExpired(ref);
        return response(res, 200, { status: 'expired' });
      }
      return response(res, 200, { status: 'pending', expires_at: order.expires_at });
    }
    if (path === 'pay/utr' && req.method === 'POST') {
      const { ref, data: order } = await getOwnedFamGatewayOrder(user, req.body?.order_id);
      const enteredUtr = normalizeUtr(req.body?.utr);
      if (!/^[A-Z0-9]{6,40}$/.test(enteredUtr)) throw fail('Enter a valid UTR or transaction reference.');
      if (order.status === 'success') {
        if (enteredUtr !== normalizeUtr(order.utr)) throw fail('The UTR does not match the verified payment.', 422);
        return response(res, 200, { status: 'success', credited: true, amount: order.payable_amount });
      }
      const verified = await verifyFamGatewayOrder(order);
      if (verified.status === 'expired') {
        await markFamGatewayExpired(ref);
        return response(res, 200, { status: 'expired' });
      }
      if (verified.status !== 'success') {
        if (Date.now() >= Number(order.expires_at_ms || 0)) {
          await markFamGatewayExpired(ref);
          return response(res, 200, { status: 'expired' });
        }
        return response(res, 200, { status: 'pending', message: 'Payment is not confirmed yet. Check the UTR again in a moment.' });
      }
      if (!verified.utr || enteredUtr !== verified.utr)
        throw fail('The entered UTR does not match a confirmed FamGateway payment. No wallet credit was made.', 422);
      return response(res, 200, await creditVerifiedFamGatewayOrder(ref, verified));
    }
    if (path === 'reseller/upgrade-info' && req.method === 'GET') {
      const snap = await db.collection('settings').doc('resellerUpgrade').get();
      const data = snap.exists ? snap.data() : {};
      const fee = Number(data.fee ?? data.price ?? 0), minimumBalance = Number(data.minimumBalance ?? 0);
      return response(res, 200, {
        fee: fee > 0 ? fee : null, minimumBalance: data.minimumBalance == null ? null : (Number.isFinite(minimumBalance) ? minimumBalance : 0),
        visible: data.visible !== false, active: data.active !== false,
        description: String(data.description || ''), rules: String(data.rules || ''), balance: Number(user.balance || 0), role: user.role
      });
    }
    if (path === 'upgrade' && req.method === 'POST') {
      const userRef = db.collection('users').doc(user.uid), settingsRef = db.collection('settings').doc('resellerUpgrade');
      const upgradeRef = db.collection('resellerUpgrades').doc(user.uid);
      const transactionRef = db.collection('transactions').doc(`reseller_upgrade_${user.uid}`);
      const result = await db.runTransaction(async tx => {
        const [snap, settings] = await Promise.all([tx.get(userRef), tx.get(settingsRef)]);
        if (!snap.exists) throw fail('User account not found.', 404);
        if (normalizeRole(snap.data().role) !== 'USER') throw fail('Only customer accounts can upgrade to reseller.');
        const config = settings.exists ? settings.data() : {};
        if (config.visible === false || config.active === false) throw fail('Reseller upgrades are currently unavailable.', 409);
        const amount = Number(config.fee ?? config.price ?? 0), minimum = Number(config.minimumBalance ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) throw fail('Reseller upgrade fee has not been configured by the admin.', 409);
        if (!Number.isFinite(minimum) || minimum < 0) throw fail('Reseller upgrade minimum balance is not configured correctly.', 409);
        const balance = Number(snap.data().balance || 0);
        if (balance < minimum || balance < amount) throw fail('Insufficient Wallet Balance. Please add funds to upgrade your account.', 402);
        const existingUpgrade = await tx.get(upgradeRef);
        if (existingUpgrade.exists) throw fail('A reseller upgrade has already been recorded for this account.', 409);
        const now = new Date().toISOString();
        const remaining = Math.round((balance - amount) * 100) / 100;
        const record = {
          uid: user.uid, username: String(snap.data().username || String(snap.data().email || user.uid).split('@')[0]),
          fee: amount, previousBalance: balance, remainingBalance: remaining, status: 'SUCCESS', created: now
        };
        tx.update(userRef, { balance: remaining, role: 'RESELLER', reseller_pricing_enabled: true, updated: now });
        tx.create(transactionRef, { uid: user.uid, type: 'Purchase', detail: 'Reseller account upgrade', amount: -amount, created: now });
        tx.create(upgradeRef, record);
        return record;
      });
      return response(res, 200, { ok: true, charged: result.fee, previousBalance: result.previousBalance, remainingBalance: result.remainingBalance, role: 'RESELLER' });
    }

    if (path.startsWith('admin/')) requireAdmin(user);
    if (path === 'admin/reseller-upgrade-settings' && req.method === 'GET') {
      const [settingsSnap, upgradeRows] = await Promise.all([
        db.collection('settings').doc('resellerUpgrade').get(),
        list(db.collection('resellerUpgrades').orderBy('created', 'desc'), 5000)
      ]);
      const config = settingsSnap.exists ? settingsSnap.data() : {};
      const fee = config.fee ?? config.price ?? null;
      return response(res, 200, {
        settings: {
          minimumBalance: config.minimumBalance ?? null, fee: fee == null ? null : Number(fee),
          visible: config.visible !== false, active: config.active !== false,
          description: String(config.description || ''), rules: String(config.rules || '')
        }, upgrades: upgradeRows
      });
    }
    if (path === 'admin/reseller-upgrade-settings' && req.method === 'POST') {
      const minimumBalance = number(req.body?.minimumBalance, 'minimum wallet balance', 0);
      const fee = number(req.body?.fee, 'reseller upgrade fee', 0.01);
      if (minimumBalance > 10000000 || fee > 10000000) throw fail('Upgrade amounts are too high.');
      const description = String(req.body?.description || '').trim().slice(0, 500);
      const rules = String(req.body?.rules || '').trim().slice(0, 3000);
      const visible = req.body?.visible === true, active = req.body?.active === true;
      await db.collection('settings').doc('resellerUpgrade').set({
        minimumBalance, fee, price: fee, visible, active, description, rules,
        updated: new Date().toISOString(), updated_by: user.uid
      }, { merge: true });
      return response(res, 200, { ok: true, settings: { minimumBalance, fee, visible, active, description, rules } });
    }
    if (path === 'admin/reseller-upgrade-price' && req.method === 'GET') {
      const snap = await db.collection('settings').doc('resellerUpgrade').get();
      const config = snap.exists ? snap.data() : {};
      return response(res, 200, { price: config.fee ?? config.price ?? null });
    }
    if (path === 'admin/reseller-upgrade-price' && req.method === 'POST') {
      const price = number(req.body?.price, 'reseller upgrade price', 0.01);
      if (price > 1000000) throw fail('Reseller upgrade price is too high.');
      await db.collection('settings').doc('resellerUpgrade').set({ price, fee: price, updated: new Date().toISOString(), updated_by: user.uid }, { merge: true });
      return response(res, 200, { ok: true, price });
    }
    if (path === 'admin/reseller/status' && req.method === 'GET') {
      const meta = await db.collection('settings').doc('resellerCatalog').get();
      const data = meta.exists ? meta.data() : {};
      return response(res, 200, {
        endpoint: RESELLER_API_URL, configured: Boolean(resellerApiKey.value()), enabled: data.enabled !== false,
        masterKeyRequired: Boolean(resellerMasterKey.value()), status: data.status || 'not_synced',
        totalPlans: data.totalPlans || 0, imported: data.imported || 0, updated: data.updated || 0,
        unavailable: data.unavailable || 0, lastSync: data.lastSync || null, nextSync: data.nextSync || null,
        balance: data.balance ?? null, lowBalance: data.lowBalance ?? null,
        connectionStatus: data.connectionStatus || 'not_checked', lastBalanceCheck: data.lastBalanceCheck || null
      });
    }
    if (path === 'admin/reseller/settings' && req.method === 'POST') {
      const enabled = req.body?.enabled === true;
      await db.collection('settings').doc('resellerCatalog').set({ enabled, updated: new Date().toISOString() }, { merge: true });
      if (!enabled) {
        const snap = await db.collection('products').where('source', '==', 'reseller_api').get();
        for (let i = 0; i < snap.docs.length; i += 450) {
          const batch = db.batch();
          snap.docs.slice(i, i + 450).forEach(doc => batch.set(doc.ref, { active: false }, { merge: true }));
          await batch.commit();
        }
      }
      return response(res, 200, { enabled });
    }
    if (path === 'admin/reseller/test' && req.method === 'POST') {
      const result = await resellerRequest('balance');
      const data = result.data || result;
      const balance = Number(data.balance ?? data.current_balance ?? 0);
      const lowBalance = truthy(data.low_balance ?? data.lowBalance);
      const checkedAt = new Date().toISOString();
      await db.collection('settings').doc('resellerCatalog').set({ connectionStatus: 'connected', balance: Number.isFinite(balance) ? balance : null, lowBalance, lastBalanceCheck: checkedAt }, { merge: true });
      return response(res, 200, { connected: true, balance: Number.isFinite(balance) ? balance : null, lowBalance, checkedAt });
    }
    if (path === 'admin/reseller/sync' && req.method === 'POST')
      return response(res, 200, await syncResellerCatalog());
    if (path === 'admin/reseller/logs' && req.method === 'GET')
      return response(res, 200, await list(db.collection('resellerSyncLogs').orderBy('created', 'desc'), 30));
    if (path === 'admin/products' && req.method === 'GET')
      return response(res, 200, await list(db.collection('products')));
    if (path === 'admin/products/update' && req.method === 'POST') {
      const id = String(req.body?.product_id || '');
      if (!/^reseller_[a-zA-Z0-9_-]{1,100}$/.test(id)) throw fail('Select a valid imported reseller plan.');
      const ref = db.collection('products').doc(id);
      const snap = await ref.get();
      if (!snap.exists || snap.data().source !== 'reseller_api') throw fail('Imported plan not found.', 404);
      const old = snap.data(), patch = { updated: new Date().toISOString() };
      if (Object.prototype.hasOwnProperty.call(req.body, 'price')) {
        patch.price = number(req.body.price, 'website selling price');
        patch.price_source = patch.price > 0 ? 'custom' : 'unconfigured';
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'reseller_price')) {
        patch.reseller_price = req.body.reseller_price === '' || req.body.reseller_price == null ? null : number(req.body.reseller_price, 'reseller price');
        patch.reseller_price_source = patch.reseller_price == null ? 'api_default' : 'custom';
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
        const name = String(req.body.name || '').trim().slice(0, 120);
        if (!name) throw fail('Product name is required.');
        patch.name = name; patch.custom_name = true;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
        patch.description = String(req.body.description || '').trim().slice(0, 1200); patch.custom_description = true;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'category')) patch.category = String(req.body.category || '').trim().slice(0, 80);
      if (Object.prototype.hasOwnProperty.call(req.body, 'display_order')) patch.display_order = number(req.body.display_order, 'display order');
      if (Object.prototype.hasOwnProperty.call(req.body, 'visible')) patch.visible = req.body.visible === true;
      if (req.body.reset_image === true) {
        patch.image = old.api_image || ''; patch.image_source = 'api_default';
      } else if (Object.prototype.hasOwnProperty.call(req.body, 'image')) {
        const image = String(req.body.image || '').trim();
        const validRemote = /^https:\/\//i.test(image);
        const validUpload = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(image) && image.length <= 800000;
        if (image && !validRemote && !validUpload) throw fail('Use an HTTPS image URL or upload a PNG, JPEG, or WebP image under 600 KB.');
        patch.image = image || old.api_image || ''; patch.image_source = image ? 'custom' : 'api_default';
      }
      const next = { ...old, ...patch };
      patch.active = next.api_available === true && next.visible !== false && Number(next.price || 0) > 0;
      await ref.set(patch, { merge: true });
      return response(res, 200, { ok: true, id, active: patch.active });
    }
    if (path === 'admin/products/group-update' && req.method === 'POST') {
      const productId = String(req.body?.product_id || '').trim();
      const requestedPlans = req.body?.plans;
      if (!productId || productId.length > 100 || !Array.isArray(requestedPlans) || !requestedPlans.length || requestedPlans.length > 100) throw fail('Select a valid API product and its duration plans.');
      const catalogSnap = await db.collection('products').where('source', '==', 'reseller_api').get();
      const productDocs = catalogSnap.docs.filter(doc => String(doc.data().product_id) === productId);
      if (!productDocs.length) throw fail('Imported API product not found.', 404);
      const rows = new Map(requestedPlans.map(x => [String(x?.id || ''), x]));
      if (rows.size !== productDocs.length || productDocs.some(doc => !rows.has(doc.id))) throw fail('The product duration list changed. Refresh the page and try again.', 409);
      const name = String(req.body?.name || '').trim().slice(0, 120);
      if (!name) throw fail('Product name is required.');
      const visible = req.body?.visible === true;
      const category = String(req.body?.category || '').trim().slice(0, 80);
      const device = String(req.body?.device || 'All Devices').trim();
      if (!['All Devices', 'Android', 'iOS', 'PC', 'Multi-platform'].includes(device)) throw fail('Select a valid device type.');
      const description = String(req.body?.description || '').trim().slice(0, 1200);
      const displayOrder = number(req.body?.display_order ?? 0, 'display order');
      const updateUrl = String(req.body?.update_url || '').trim();
      if (updateUrl && (!/^https:\/\//i.test(updateUrl) || updateUrl.length > 2048)) throw fail('Update file link must be a valid HTTPS URL.');
      let image = '';
      if (req.body?.reset_image !== true && Object.prototype.hasOwnProperty.call(req.body || {}, 'image')) {
        image = String(req.body.image || '').trim();
        const validRemote = /^https:\/\//i.test(image);
        const validUpload = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(image) && image.length <= 800000;
        if (image && !validRemote && !validUpload) throw fail('Use an HTTPS image URL or upload a PNG, JPEG, or WebP image under 600 KB.');
      }
      const batch = db.batch(), updatedAt = new Date().toISOString();
      for (const doc of productDocs) {
        const old = doc.data(), row = rows.get(doc.id);
        const price = number(row.website_price, 'website selling price');
        const resellerPrice = row.reseller_price === '' || row.reseller_price == null ? null : number(row.reseller_price, 'reseller price');
        const nextImage = req.body?.reset_image === true || !image ? (old.api_image || '') : image;
        const patch = {
          name, custom_name: true, category, description, custom_description: true,
          display_order: displayOrder, device, visible, storefront_added: visible, update_url: updateUrl,
          price: price > 0 ? price : null, price_source: price > 0 ? 'custom' : 'unconfigured',
          reseller_price: resellerPrice && resellerPrice > 0 ? resellerPrice : null,
          reseller_price_source: resellerPrice && resellerPrice > 0 ? 'custom' : 'unconfigured',
          image: nextImage, image_source: nextImage && nextImage !== old.api_image ? 'custom' : 'api_default',
          active: old.api_available === true && visible && (price > 0 || Number(resellerPrice || 0) > 0),
          updated: updatedAt
        };
        batch.set(doc.ref, patch, { merge: true });
      }
      await batch.commit();
      return response(res, 200, { ok: true, product_id: productId, plansUpdated: productDocs.length });
    }
    if (path === 'admin/reseller-prices' && req.method === 'GET') {
      const products = await list(db.collection('products').where('source', '==', 'reseller_api'), 5000);
      return response(res, 200, products.map(p => ({ id: p.id, product_id: String(p.product_id), plan_id: p.plan_id, name: p.name || p.api_name || '', duration: p.duration || '', category: p.category || '', price: p.price ?? null, reseller_price: p.reseller_price ?? null, visible: p.storefront_added === true && p.visible !== false, api_available: p.api_available === true })));
    }
    if (path === 'admin/reseller-prices/update' && req.method === 'POST') {
      const productId = String(req.body?.product_id || '').trim(), requested = req.body?.plans;
      if (!productId || !Array.isArray(requested) || !requested.length || requested.length > 100) throw fail('Select a product and its duration plans.');
      const snap = await db.collection('products').where('source', '==', 'reseller_api').get();
      const docs = snap.docs.filter(d => String(d.data().product_id) === productId);
      const rows = new Map(requested.map(r => [String(r.id || ''), r]));
      if (!docs.length || rows.size !== docs.length || docs.some(d => !rows.has(d.id))) throw fail('The product plans changed. Refresh the page and try again.', 409);
      const batch = db.batch();
      for (const doc of docs) {
        const row = rows.get(doc.id), price = row.price === '' || row.price == null ? null : number(row.price, 'normal customer price', 0.01);
        const resellerPrice = row.reseller_price === '' || row.reseller_price == null ? null : number(row.reseller_price, 'reseller price', 0.01);
        const old = doc.data();
        batch.update(doc.ref, { price, price_source: price == null ? 'unconfigured' : 'custom', reseller_price: resellerPrice, reseller_price_source: resellerPrice == null ? 'unconfigured' : 'custom', active: old.api_available === true && old.visible !== false && old.storefront_added === true && (price != null || resellerPrice != null), updated: new Date().toISOString() });
      }
      await batch.commit();
      return response(res, 200, { ok: true, plansUpdated: docs.length });
    }
    if (path === 'admin/resellers/search' && req.method === 'GET') {
      const q = String(req.query?.username || '').trim().toLowerCase();
      if (q.length < 2) throw fail('Enter at least 2 characters of the reseller username.');
      const snap = await db.collection('users').get();
      const matches = snap.docs.map(d => ({ id: d.id, ...d.data(), role: normalizeRole(d.data().role) })).filter(u => u.role === 'RESELLER' || u.role === 'USER').map(u => ({ id: u.id, name: u.name || '', username: u.username || String(u.email || '').split('@')[0].toLowerCase(), email: u.email || '', role: u.role, balance: Number(u.balance || 0), reseller_pricing_enabled: u.role === 'RESELLER' && u.reseller_pricing_enabled !== false })).filter(u => u.username.includes(q)).sort((a, b) => a.username.localeCompare(b.username)).slice(0, 20);
      return response(res, 200, matches);
    }
    if (path === 'admin/reseller-assignments' && req.method === 'GET') {
      const q = String(req.query?.username || '').trim().toLowerCase();
      if (q.length < 2) throw fail('Enter at least 2 characters of the username.');
      const snap = await db.collection('users').get();
      const all = snap.docs.map(d => ({ id: d.id, ...d.data(), role: normalizeRole(d.data().role) }));
      const resellers = all.filter(u => u.role === 'RESELLER').map(u => ({ id: u.id, name: u.name || '', username: u.username || String(u.email || '').split('@')[0].toLowerCase() })).sort((a,b) => a.username.localeCompare(b.username));
      const users = all.filter(u => ['USER','RESELLER'].includes(u.role)).map(u => ({ id: u.id, name: u.name || '', username: u.username || String(u.email || '').split('@')[0].toLowerCase(), email: u.email || '', role: u.role, assigned_reseller_uid: u.assigned_reseller_uid || '', assigned_reseller_username: u.assigned_reseller_username || '' })).filter(u => u.username.toLowerCase().includes(q)).sort((a,b) => a.username.localeCompare(b.username)).slice(0,30);
      return response(res, 200, { users, resellers });
    }
    if (path === 'admin/reseller-assignments' && req.method === 'POST') {
      const userUid = String(req.body?.user_uid || '').trim(), resellerUid = String(req.body?.reseller_uid || '').trim();
      if (!userUid) throw fail('Select the user whose reseller assignment should change.');
      const targetRef = db.collection('users').doc(userUid), resellerRef = resellerUid ? db.collection('users').doc(resellerUid) : null;
      const logRef = db.collection('adminActivity').doc();
      const now = new Date().toISOString();
      const assignment = await db.runTransaction(async tx => {
        const targetSnap = await tx.get(targetRef);
        const resellerSnap = resellerRef ? await tx.get(resellerRef) : null;
        if (!targetSnap.exists || !['USER','RESELLER'].includes(normalizeRole(targetSnap.data().role))) throw fail('User account not found.', 404);
        if (resellerSnap && (!resellerSnap.exists || normalizeRole(resellerSnap.data().role) !== 'RESELLER')) throw fail('Choose an active reseller account.', 400);
        const old = targetSnap.data(), previousUid = String(old.assigned_reseller_uid || ''), previousUsername = String(old.assigned_reseller_username || '');
        const resellerUsername = resellerSnap ? String(resellerSnap.data().username || String(resellerSnap.data().email || '').split('@')[0]).trim() : '';
        tx.update(targetRef, { assigned_reseller_uid: resellerRef ? resellerUid : null, assigned_reseller_username: resellerRef ? resellerUsername : null, reseller_assignment_updated: now, reseller_assignment_updated_by: user.uid, updated: now });
        tx.create(logRef, { type: 'RESELLER_ASSIGNMENT_CHANGED', target_uid: userUid, target_username: String(old.username || String(old.email || '').split('@')[0]), previous_reseller_uid: previousUid || null, previous_reseller_username: previousUsername || null, reseller_uid: resellerRef ? resellerUid : null, reseller_username: resellerRef ? resellerUsername : null, admin_uid: user.uid, created: now });
        return { previousUsername, resellerUsername };
      });
      return response(res, 200, { ok: true, ...assignment });
    }
    if (path === 'admin/resellers/account' && req.method === 'GET') {
      const uid = String(req.query?.uid || '').trim();
      if (!uid) throw fail('Select a reseller account.');
      const ref = db.collection('users').doc(uid), snap = await ref.get();
      if (!snap.exists || !['USER', 'RESELLER'].includes(snap.data().role)) throw fail('Account not found.', 404);
      const u = snap.data(), txs = await list(db.collection('transactions').where('uid', '==', uid), 500);
      txs.sort((a, b) => String(b.created).localeCompare(String(a.created)));
      const role = normalizeRole(u.role);
      return response(res, 200, { id: uid, name: u.name || '', username: u.username || String(u.email || '').split('@')[0].toLowerCase(), email: u.email || '', role, balance: Number(u.balance || 0), created: u.created || '', reseller_pricing_enabled: role === 'RESELLER' && u.reseller_pricing_enabled !== false, transactions: txs });
    }
    if (path === 'admin/resellers/promote' && req.method === 'POST') {
      let uid = String(req.body?.uid || '').trim();
      if (req.body?.username) {
        const target = await findUserByUsername(req.body.username);
        if (uid && uid !== target.id) throw fail('The selected username and account do not match.', 409);
        uid = target.id;
      }
      if (!uid) throw fail('Select an account or enter an exact username to promote.');
      const ref = db.collection('users').doc(uid);
      const promoted = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw fail('Account not found.', 404);
        if (normalizeRole(snap.data().role) === 'RESELLER') return false;
        if (normalizeRole(snap.data().role) !== 'USER') throw fail('Only customer accounts can be promoted to reseller.');
        tx.update(ref, { role: 'RESELLER', reseller_pricing_enabled: true, updated: new Date().toISOString() });
        return true;
      });
      return response(res, 200, { ok: true, promoted });
    }
    if (path === 'admin/resellers/permission' && req.method === 'POST') {
      const uid = String(req.body?.uid || '').trim();
      if (!uid || typeof req.body?.enabled !== 'boolean') throw fail('Select a reseller and a valid pricing permission.');
      const ref = db.collection('users').doc(uid);
      await db.runTransaction(async tx => { const s = await tx.get(ref); if (!s.exists || normalizeRole(s.data().role) !== 'RESELLER') throw fail('Reseller account not found.', 404); tx.update(ref, { reseller_pricing_enabled: req.body.enabled, updated: new Date().toISOString() }); });
      return response(res, 200, { ok: true, enabled: req.body.enabled });
    }
    if (path === 'admin/resellers/credit' && req.method === 'POST') {
      let uid = String(req.body?.uid || '').trim();
      if (req.body?.username) {
        const target = await findUserByUsername(req.body.username);
        if (uid && uid !== target.id) throw fail('The selected username and account do not match.', 409);
        uid = target.id;
      }
      const requestId = String(req.body?.request_id || '').trim(), amount = number(req.body?.amount, 'wallet amount', 0.01);
      if (!uid || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId) || amount > 1000000) throw fail('Enter a valid reseller username, request ID, and amount.');
      const userRef = db.collection('users').doc(uid), txRef = db.collection('transactions').doc(`admin_reseller_${uid}_${requestId}`), now = new Date().toISOString();
      const result = await db.runTransaction(async tx => {
        const [u, existing] = await Promise.all([tx.get(userRef), tx.get(txRef)]);
        if (!u.exists || normalizeRole(u.data().role) !== 'RESELLER') throw fail('Reseller account not found.', 404);
        if (existing.exists) { if (existing.data().uid !== uid || Number(existing.data().amount) !== amount) throw fail('This credit request ID was already used.', 409); return { balance: Number(u.data().balance || 0), duplicate: true }; }
        const balance = Math.round(Number(u.data().balance || 0) * 100 + amount * 100) / 100;
        tx.update(userRef, { balance, updated: now });
        tx.create(txRef, { uid, type: 'Deposit', detail: `Admin wallet credit for reseller ${u.data().username || String(u.data().email || '').split('@')[0]}`, amount, created: now, admin_uid: user.uid, request_id: requestId });
        return { balance, duplicate: false };
      });
      return response(res, 200, { ok: true, ...result });
    }
    if (path === 'admin/users' && req.method === 'GET') {
      const users = await list(db.collection('users').orderBy('created', 'desc'), 200);
      return response(res, 200, users);
    }
    if (path === 'admin/stats' && req.method === 'GET') {
      const [users, keys, txs] = await Promise.all([
        db.collection('users').count().get(), db.collection('keys').count().get(),
        list(db.collection('transactions'), 5000)
      ]);
      const deposits = txs.filter(x => x.type === 'Deposit').reduce((n, x) => n + Number(x.amount || 0), 0);
      const sales = txs.filter(x => x.type === 'Purchase').reduce((n, x) => n + Math.abs(Number(x.amount || 0)), 0);
      return response(res, 200, { users: users.data().count, keys: keys.data().count, deposits, sales });
    }
    if (path === 'admin/product' && req.method === 'POST') {
      const { name, price, reseller_price, days, category } = req.body || {};
      if (!String(name || '').trim()) throw fail('Product name is required.');
      const doc = await db.collection('products').add({
        name: String(name).trim().slice(0, 120), price: number(price, 'price'),
        reseller_price: reseller_price === '' || reseller_price == null ? null : number(reseller_price, 'reseller price'),
        days: number(days, 'validity days'), category: String(category || '').trim().slice(0, 80), active: true,
        created: new Date().toISOString()
      });
      return response(res, 200, { id: doc.id });
    }
    if (path === 'admin/credit' && req.method === 'POST') {
      const target = await findUserByUsername(req.body?.username);
      const delta = Number(req.body?.amount), requestId = String(req.body?.request_id || '').trim();
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000000) throw fail('Enter a non-zero wallet adjustment up to ₹1,000,000.');
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw fail('A valid wallet request ID is required.');
      const userRef = target.ref, txRef = db.collection('transactions').doc(`admin_wallet_${target.id}_${requestId}`), now = new Date().toISOString();
      const result = await db.runTransaction(async tx => {
        const [snap, existing] = await Promise.all([tx.get(userRef), tx.get(txRef)]);
        if (!snap.exists) throw fail('Account not found.', 404);
        if (existing.exists) {
          if (existing.data().uid !== target.id || Number(existing.data().amount) !== delta) throw fail('This wallet request ID was already used.', 409);
          return { balance: Number(snap.data().balance || 0), duplicate: true };
        }
        const current = Number(snap.data().balance || 0), next = Math.round((current + delta) * 100) / 100;
        if (next < 0) throw fail('Balance cannot be negative.');
        tx.update(userRef, { balance: next, updated: now });
        tx.create(txRef, {
          uid: target.id, type: delta > 0 ? 'Deposit' : 'Adjustment', detail: 'Admin wallet adjustment',
          amount: delta, created: now, admin_uid: user.uid, request_id: requestId
        });
        return { balance: next, duplicate: false };
      });
      return response(res, 200, { ok: true, username: String(target.data().username || String(target.data().email || '').split('@')[0]), ...result });
    }

    if (path.startsWith('pay/')) throw fail('Payment route not found.', 404);
    if (path === 'buy' && req.method === 'POST')
      return response(res, 200, await performResellerPurchase(user, req.body || {}));
    if (path === 'admin/revoke' && req.method === 'POST') {
      const key = String(req.body?.key || '');
      const snap = await db.collection('keys').where('key', '==', key).limit(1).get();
      if (snap.empty) throw fail('License key not found.', 404);
      await snap.docs[0].ref.update({ revoked: true });
      return response(res, 200, { ok: true });
    }
    return response(res, 404, { error: 'API route not found.' });
  } catch (e) {
    console.error('API request failed:', e.message || e);
    return response(res, e.status || 500, { error: e.message || 'Server error.' });
  }
}

module.exports = { api, syncResellerCatalog };

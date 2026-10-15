/* Pure local-cart model. No network, prices, stock reservations or checkout. */
export const CART_VERSION = 1;
export const CART_STORAGE_KEY = 'showave.store.cart.v1';
export const MAX_QUANTITY = 25;
export const MAX_TOTAL_QUANTITY = 100;
export const MAX_LINES = 40;
const COLORS = Object.freeze([
  Object.freeze({ id: 'wave-black', label: 'Wave black', hex: '#242b36' }),
  Object.freeze({ id: 'signal-orange', label: 'Signal orange', hex: '#bb4f31' }),
  Object.freeze({ id: 'studio-ivory', label: 'Studio ivory', hex: '#c6c1b4' })
]);
export const PRODUCTS = Object.freeze([
  Object.freeze({ id: 'crew-shirt', name: 'Focus crew shirt', category: 'Crew wear', shape: 'shirt', number: '01', description: 'A clean wolf chest mark and SHOWAVE lettering. A concept for the people behind the production.', sizes: Object.freeze(['XS', 'S', 'M', 'L', 'XL', '2XL']), colors: COLORS }),
  Object.freeze({ id: 'wave-hoodie', name: 'Wave hoodie', category: 'Crew wear', shape: 'hoodie', number: '02', description: 'A larger square wolf mark, with the SHOWAVE name across the front. Artwork placement is a concept.', sizes: Object.freeze(['S', 'M', 'L', 'XL', '2XL']), colors: COLORS }),
  Object.freeze({ id: 'focus-cap', name: 'Focus cap', category: 'Everyday gear', shape: 'cap', number: '03', description: 'A focused wolf patch on a simple cap silhouette. Fit and manufacturing details need confirmation.', sizes: Object.freeze(['One size']), colors: COLORS }),
  Object.freeze({ id: 'wave-tote', name: 'Wave tote', category: 'Everyday gear', shape: 'tote', number: '04', description: 'A square SHOWAVE wolf mark on a carry-all concept. Dimensions and materials are not yet specified.', sizes: Object.freeze(['One size']), colors: COLORS })
]);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export const emptyCart = () => ({ version: CART_VERSION, items: [] });
export const getProduct = id => typeof id === 'string' ? PRODUCTS.find(product => product.id === id) || null : null;
export const lineKey = item => `${item.productId}|${item.size}|${item.color}`;
export const totalQuantity = cart => sanitizeCart(cart).items.reduce((sum, item) => sum + item.quantity, 0);

function validLine(value) {
  if (!plain(value)) return null;
  const product = getProduct(value.productId);
  if (!product || !product.sizes.includes(value.size) || !product.colors.some(color => color.id === value.color)
      || !Number.isSafeInteger(value.quantity) || value.quantity < 1) return null;
  return { productId: product.id, size: value.size, color: value.color, quantity: Math.min(value.quantity, MAX_QUANTITY) };
}

export function sanitizeCart(value) {
  if (!plain(value) || value.version !== CART_VERSION || !Array.isArray(value.items)) return emptyCart();
  const items = [], keys = new Map();
  let total = 0;
  // Limit work as well as state size when reading untrusted browser storage.
  for (const raw of value.items.slice(0, 200)) {
    const line = validLine(raw);
    if (!line) continue;
    const key = lineKey(line), existing = keys.get(key);
    if (!existing && items.length >= MAX_LINES) continue;
    const room = Math.min(MAX_QUANTITY - (existing?.quantity || 0), MAX_TOTAL_QUANTITY - total);
    const quantity = Math.min(line.quantity, room);
    if (quantity < 1) continue;
    if (existing) existing.quantity += quantity;
    else { const item = { ...line, quantity }; items.push(item); keys.set(key, item); }
    total += quantity;
  }
  return { version: CART_VERSION, items };
}

export function parseStoredCart(serialized) {
  if (serialized === null || serialized === undefined || serialized === '') return { cart: emptyCart(), notice: '' };
  if (typeof serialized !== 'string' || serialized.length > 100000) return { cart: emptyCart(), notice: 'The stored cart could not be read. Start a new local request.' };
  try {
    const raw = JSON.parse(serialized), cart = sanitizeCart(raw);
    const exact = plain(raw) && raw.version === CART_VERSION && Array.isArray(raw.items)
      && raw.items.length === cart.items.length && raw.items.every((item, index) => plain(item)
        && Object.keys(item).length === 4 && ['productId', 'size', 'color', 'quantity'].every(key => item[key] === cart.items[index][key]));
    return { cart, notice: exact ? '' : 'Stored cart entries were validated and normalized. Review your requested choices.' };
  } catch { return { cart: emptyCart(), notice: 'The stored cart could not be read. Start a new local request.' }; }
}

function requestedLine(value) {
  const line = validLine(value);
  if (!line || value.quantity > MAX_QUANTITY) throw new RangeError(`Choose a listed product, size and color, with a whole quantity from 1 to ${MAX_QUANTITY}.`);
  return line;
}

export function addItem(cart, value) {
  const line = requestedLine(value), clean = sanitizeCart(cart);
  return sanitizeCart({ version: CART_VERSION, items: [...clean.items, line] });
}

export function setQuantity(cart, key, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new RangeError(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  const clean = sanitizeCart(cart), index = clean.items.findIndex(item => lineKey(item) === key);
  if (index < 0) throw new RangeError('That local cart entry no longer exists.');
  const otherTotal = clean.items.reduce((sum, item, i) => sum + (i === index ? 0 : item.quantity), 0);
  clean.items[index].quantity = Math.min(quantity, MAX_TOTAL_QUANTITY - otherTotal);
  return sanitizeCart(clean);
}

export function removeItem(cart, key) {
  const clean = sanitizeCart(cart);
  return { version: CART_VERSION, items: clean.items.filter(item => lineKey(item) !== key) };
}

export function changeVariant(cart, key, { size, color }) {
  const clean = sanitizeCart(cart), line = clean.items.find(item => lineKey(item) === key);
  if (!line) throw new RangeError('That local cart entry no longer exists.');
  const changed = requestedLine({ ...line, size, color });
  const others = clean.items.filter(item => lineKey(item) !== key);
  return sanitizeCart({ version: CART_VERSION, items: [...others, changed] });
}

export function createOrderDraft(cart, { notes = '', now = new Date() } = {}) {
  const clean = sanitizeCart(cart);
  if (!clean.items.length) throw new RangeError('Add a merchandise concept to your local cart before exporting.');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('A valid export date is required.');
  const text = typeof notes === 'string' ? notes.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 2000) : '';
  return {
    schema: 'showave-merchandise-request', schemaVersion: 1, createdAt: now.toISOString(),
    brand: 'SHOWAVE', poweredBy: 'Afro Unity Group', status: 'draft_not_submitted',
    purpose: 'quote_and_availability_request',
    notice: 'This file is a local request draft. No order, reservation, payment or submission has been made. Price, stock, materials, sizing, delivery and payment arrangements require confirmation.',
    items: clean.items.map(item => {
      const product = getProduct(item.productId), color = product.colors.find(choice => choice.id === item.color);
      return { productId: item.productId, productName: product.name, size: item.size,
        colorId: item.color, color: color.label, requestedQuantity: item.quantity,
        merchandiseStatus: 'concept', price: null, availability: 'unconfirmed' };
    }),
    requestedUnits: clean.items.reduce((sum, item) => sum + item.quantity, 0),
    priceTotal: null, currency: null, shipping: 'not_configured', payment: 'not_configured',
    submission: 'no_submission_endpoint_configured', notes: text
  };
}

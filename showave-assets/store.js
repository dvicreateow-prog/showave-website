import { CART_STORAGE_KEY, MAX_QUANTITY, MAX_TOTAL_QUANTITY, emptyCart, getProduct, lineKey,
  totalQuantity, parseStoredCart, sanitizeCart, addItem, setQuantity, removeItem, changeVariant, createOrderDraft } from './store-model.js';

const root = document.querySelector('[data-showave-store]');
if (root) {
  const itemsMount = root.querySelector('#store-cart-items');
  const count = root.querySelector('#store-cart-count');
  const status = root.querySelector('#store-status');
  const exportButton = root.querySelector('#store-export');
  const clearButton = root.querySelector('#store-clear');
  const notes = root.querySelector('#store-order-notes');
  const cartIntro = root.querySelector('.store-cart-intro');
  let cart = emptyCart(), storageAvailable = true;
  const say = message => { status.textContent = message; };
  const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  function storageUnavailable() {
    storageAvailable = false;
    cartIntro.textContent = 'Choices remain on this page for this visit. Nothing is sent to SHOWAVE.';
  }
  try { const stored = parseStoredCart(localStorage.getItem(CART_STORAGE_KEY)); cart = stored.cart; if (stored.notice) say(stored.notice); }
  catch { storageUnavailable(); say('Your cart works for this visit. Browser storage is unavailable.'); }
  function save() {
    if (!storageAvailable) return;
    try { if (cart.items.length) localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart)); else localStorage.removeItem(CART_STORAGE_KEY); }
    catch { storageUnavailable(); say('Your cart works for this visit. Browser storage could not be updated.'); }
  }
  const lineDescription = item => {
    const product = getProduct(item.productId), color = product.colors.find(choice => choice.id === item.color);
    return `${product.name}, ${item.size}, ${color.label}`;
  };
  function optionSelect(label, choices, current, key, field, index) {
    const wrapper = element('label', 'store-cart-field', label);
    const select = element('select'); select.id = `store-cart-${index}-${field}`; select.dataset.variantKey = key; select.dataset.variantField = field;
    wrapper.htmlFor = select.id;
    for (const choice of choices) { const option = element('option', '', choice.label); option.value = choice.id; option.selected = choice.id === current; select.append(option); }
    wrapper.append(select); return wrapper;
  }
  function render({ focusKey, focusField, focusHeading = false } = {}) {
    const fragment = document.createDocumentFragment();
    cart = sanitizeCart(cart);
    if (!cart.items.length) fragment.append(element('p', 'store-empty', 'Your cart is empty. Add a concept to start a request.'));
    cart.items.forEach((item, index) => {
      const product = getProduct(item.productId), key = lineKey(item), row = element('div', 'store-cart-item'); row.dataset.cartKey = key;
      const heading = element('div', 'store-cart-item-heading'); heading.append(element('h3', '', product.name));
      const remove = element('button', 'store-remove', 'Remove'); remove.type = 'button'; remove.dataset.removeKey = key; remove.setAttribute('aria-label', `Remove ${lineDescription(item)} from local cart`); heading.append(remove); row.append(heading);
      const variants = element('div', 'store-cart-variants');
      variants.append(optionSelect('Requested size', product.sizes.map(size => ({ id: size, label: size })), item.size, key, 'size', index));
      variants.append(optionSelect('Concept color', product.colors, item.color, key, 'color', index)); row.append(variants);
      const label = element('label', 'store-cart-quantity', 'Quantity'); const input = element('input'); input.id = `store-cart-${index}-quantity`; input.type = 'number'; input.min = '1'; input.max = String(MAX_QUANTITY); input.step = '1'; input.value = String(item.quantity); input.inputMode = 'numeric'; input.required = true; input.dataset.quantityKey = key; label.htmlFor = input.id; label.append(input); row.append(label);
      row.append(element('p', 'store-cart-item-state', 'Concept · quote and availability required')); fragment.append(row);
    });
    itemsMount.replaceChildren(fragment); count.textContent = String(totalQuantity(cart));
    exportButton.disabled = clearButton.disabled = cart.items.length === 0;
    if (focusKey) {
      const control = [...itemsMount.querySelectorAll('input, select')].find(node => focusField === 'quantity'
        ? node.dataset.quantityKey === focusKey : node.dataset.variantKey === focusKey && node.dataset.variantField === focusField);
      control?.focus();
    }
    if (focusHeading) root.querySelector('#store-cart-title').focus();
  }
  for (const form of root.querySelectorAll('[data-store-add]')) {
    form.querySelector('button[type="submit"]').disabled = false;
    const product = getProduct(form.dataset.storeAdd), card = form.closest('[data-store-product]');
    form.elements.color.addEventListener('change', () => {
      const color = product.colors.find(choice => choice.id === form.elements.color.value);
      if (color) card.style.setProperty('--store-fabric', color.hex);
    });
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      try {
        const before = totalQuantity(cart), item = { productId: product.id, size: form.elements.size.value, color: form.elements.color.value, quantity: Number(form.elements.quantity.value) };
        cart = addItem(cart, item); save(); render(); const added = totalQuantity(cart) - before;
        say(added ? `Added ${added} requested ${added === 1 ? 'unit' : 'units'} of ${lineDescription(item)}.${added < item.quantity ? ` Cart planning limits are ${MAX_QUANTITY} per variant and ${MAX_TOTAL_QUANTITY} units overall.` : ''}` : `The local cart planning limit was reached: ${MAX_QUANTITY} per variant and ${MAX_TOTAL_QUANTITY} units overall.`);
      } catch (error) { say(error.message); }
    });
  }
  itemsMount.addEventListener('click', event => {
    const button = event.target.closest('button[data-remove-key]'); if (!button) return;
    const line = cart.items.find(item => lineKey(item) === button.dataset.removeKey); cart = removeItem(cart, button.dataset.removeKey); save(); render({ focusHeading: true }); say(`${line ? lineDescription(line) : 'The entry'} was removed from your local cart.`);
  });
  itemsMount.addEventListener('change', event => {
    const input = event.target;
    try {
      if (input.dataset.quantityKey) {
        if (!input.reportValidity()) return;
        const key = input.dataset.quantityKey, requested = Number(input.value); cart = setQuantity(cart, key, requested); save();
        const applied = cart.items.find(item => lineKey(item) === key)?.quantity;
        render({ focusKey: key, focusField: 'quantity' });
        say(applied < requested ? `Requested quantity limited to ${applied} by the ${MAX_TOTAL_QUANTITY}-unit local planning limit.` : `Requested quantity updated. Your local cart contains ${totalQuantity(cart)} units; price and availability await confirmation.`);
      } else if (input.dataset.variantKey) {
        const row = input.closest('[data-cart-key]'), key = input.dataset.variantKey;
        const size = row.querySelector('[data-variant-field="size"]').value, color = row.querySelector('[data-variant-field="color"]').value;
        const old = cart.items.find(item => lineKey(item) === key), before = totalQuantity(cart);
        cart = changeVariant(cart, key, { size, color }); save(); const newKey = lineKey({ ...old, size, color }); render({ focusKey: newKey, focusField: input.dataset.variantField });
        say(`Concept variant updated.${totalQuantity(cart) < before ? ` Matching entries were combined, with a ${MAX_QUANTITY}-unit limit per variant.` : ''}`);
      }
    } catch (error) { say(error.message); }
  });
  clearButton.addEventListener('click', () => {
    cart = emptyCart(); notes.value = '';
    let removed = true;
    // A prior write failure must not prevent an explicit deletion attempt.
    try { localStorage.removeItem(CART_STORAGE_KEY); }
    catch { removed = false; storageUnavailable(); }
    render({ focusHeading: true });
    say(removed ? 'Local cart and request notes cleared.' : 'Cart and notes cleared for this visit. Browser access prevented removing the previously stored cart.');
  });
  exportButton.addEventListener('click', () => {
    let url;
    try {
      const draft = createOrderDraft(cart, { notes: notes.value }); const blob = new Blob([JSON.stringify(draft, null, 2) + '\n'], { type: 'application/json' });
      url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `showave-order-request-${draft.createdAt.slice(0, 10)}.json`; document.body.append(link); link.click(); link.remove();
      say('Order request draft exported. No order or payment was submitted.');
    } catch (error) { say(`The request could not be exported: ${error.message}`); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
  });
  window.addEventListener('storage', event => {
    if (event.key !== CART_STORAGE_KEY) return;
    const stored = parseStoredCart(event.newValue); cart = stored.cart; render(); say(stored.notice || 'Your local cart was updated in another browser tab.');
  });
  render();
}

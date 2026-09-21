// State Engine — safe thumbnails for image variables (manager modal + tracker).
//
// A thumbnail is built ONLY from a reference string that safeImageSrc()
// (core/image-variables.js) accepts: an http(s) URL, a data:image/... URL or a
// path. Everything else - a resource id, another URL scheme, empty text - gets a
// neutral placeholder that shows the reference as text. The reference is never
// put into markup unescaped, never evaluated, and nothing is fetched by State
// Engine itself: an <img> only loads when a thumbnail is actually drawn (and lazily),
// so a variable that is not on screen loads nothing.
//
// Hover-to-enlarge: hovering (or focusing) a thumbnail marked `data-enlarge` shows
// a larger copy next to it. One delegated set of listeners does this for every
// thumbnail on the page, however it was drawn.

import { safeImageSrc } from '../core/image-variables.js';

const HOVER_ID = 'se_image_hover_preview';
const ENLARGED_SIZE = 320;

export function escapeAttr(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// The inside of a thumbnail for `reference`: an <img>, or the placeholder.
// `label` is a tooltip for the placeholder (why nothing is shown).
export function thumbInnerHtml(reference, { label = '' } = {}) {
    const src = safeImageSrc(reference);
    if (src) {
        return `<img class="se-image-thumb-img" src="${escapeAttr(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false" />`;
    }
    const text = typeof reference === 'string' ? reference.trim() : '';
    const title = text ? `Not shown (not an image URL or path): ${text}` : (label || 'No image');
    return `<span class="se-image-thumb-empty" title="${escapeAttr(title)}"><i class="fa-regular fa-image"></i></span>`;
}

// A whole thumbnail element as HTML. `enlarge` adds the hover-to-enlarge behavior.
export function thumbHtml(reference, { enlarge = false, label = '', extraClass = '' } = {}) {
    const attrs = [`class="se-image-thumb ${escapeAttr(extraClass)}"`];
    if (enlarge && safeImageSrc(reference)) {
        attrs.push('data-enlarge="1"', `data-full="${escapeAttr(safeImageSrc(reference))}"`, 'tabindex="0"');
    }
    return `<span ${attrs.join(' ')}>${thumbInnerHtml(reference, { label })}</span>`;
}

// Redraws an existing thumbnail element for a new reference (live preview while
// the user types). `element` is a DOM element; returns it.
export function updateThumb(element, reference, { enlarge = false, label = '' } = {}) {
    if (!element) return element;
    element.innerHTML = thumbInnerHtml(reference, { label });
    const src = safeImageSrc(reference);
    if (enlarge && src) {
        element.setAttribute('data-enlarge', '1');
        element.setAttribute('data-full', src);
        element.setAttribute('tabindex', '0');
    } else {
        element.removeAttribute('data-enlarge');
        element.removeAttribute('data-full');
        element.removeAttribute('tabindex');
    }
    return element;
}

// ---- hover to enlarge ------------------------------------------------------------

function hoverBox() {
    let box = document.getElementById(HOVER_ID);
    if (!box) {
        box = document.createElement('div');
        box.id = HOVER_ID;
        box.className = 'se-image-hover-preview';
        box.hidden = true;
        document.body.appendChild(box);
    }
    return box;
}

export function hideEnlargedImage() {
    const box = document.getElementById(HOVER_ID);
    if (box) {
        box.hidden = true;
        box.innerHTML = '';
    }
}

// Shows the enlarged copy for `thumb` (an element with data-enlarge/data-full),
// placed beside it and kept inside the window. The enlarged <img> is created only
// now, on hover - never in advance.
export function showEnlargedImage(thumb) {
    const src = thumb?.getAttribute?.('data-full');
    if (!src || !safeImageSrc(src)) return false;
    const box = hoverBox();
    box.innerHTML = `<img src="${escapeAttr(src)}" alt="" referrerpolicy="no-referrer" draggable="false" />`;
    box.hidden = false;

    const rect = thumb.getBoundingClientRect();
    const room = ENLARGED_SIZE + 16;
    const left = rect.right + 8 + room > window.innerWidth ? Math.max(8, rect.left - 8 - room) : rect.right + 8;
    const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - room));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    return true;
}

let installed = false;

// A broken image (404, blocked, not an image) becomes the neutral placeholder.
// `error` does not bubble, so it is caught in the capture phase.
function onImageError(event) {
    const img = event.target;
    if (!(img instanceof Element) || !img.classList?.contains('se-image-thumb-img')) return;
    const thumb = img.closest('.se-image-thumb');
    if (!thumb) return;
    thumb.removeAttribute('data-enlarge');
    thumb.removeAttribute('data-full');
    thumb.innerHTML = '<span class="se-image-thumb-empty" title="The image could not be loaded"><i class="fa-regular fa-image"></i></span>';
    hideEnlargedImage();
}

function thumbOf(event) {
    const target = event.target instanceof Element ? event.target : null;
    return target ? target.closest('.se-image-thumb[data-enlarge]') : null;
}

// Installs the delegated listeners once (safe to call again).
export function initImagePreviews() {
    if (installed) return;
    installed = true;
    document.addEventListener('error', onImageError, true);
    document.addEventListener('mouseover', (event) => {
        const thumb = thumbOf(event);
        if (thumb) showEnlargedImage(thumb);
    });
    document.addEventListener('mouseout', (event) => {
        if (thumbOf(event)) hideEnlargedImage();
    });
    document.addEventListener('focusin', (event) => {
        const thumb = thumbOf(event);
        if (thumb) showEnlargedImage(thumb);
    });
    document.addEventListener('focusout', (event) => {
        if (thumbOf(event)) hideEnlargedImage();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideEnlargedImage();
    });
}

// For tests: removes the hover box (the delegated listeners live on `document`
// and stay installed for the page's life).
export function removeHoverBoxForTests() {
    document.getElementById(HOVER_ID)?.remove();
}

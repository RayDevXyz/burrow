// Theme validation. Themes end up in CSS custom properties, so every value is
// whitelisted or clamped here — nothing free-form reaches the stylesheet.

const GRADIENTS = ['aurora', 'sunset', 'ocean', 'forest', 'peach', 'night', 'candy', 'slate'];
const HEX = /^#[0-9a-f]{6}$/i;

const clamp = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, Math.round(+v))) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** http(s) URLs or our own uploaded theme images; no characters that could break out of url("…"). */
function safeImage(v) {
  if (typeof v !== 'string' || !v) return '';
  if (/^\/api\/theme-images\/[\w-]+\.(png|jpe?g|gif|webp|avif)$/i.test(v)) return v;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || /["'()\\\s<>]/.test(v)) return '';
    return u.href.slice(0, 2000);
  } catch { return ''; }
}

function sanitizeTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const bg = t.bg || {}, header = t.header || {}, cards = t.cards || {};
  const bgType = pick(bg.type, ['none', 'image', 'gradient'], 'none');
  const banner = pick(header.banner, ['none', 'gradient', 'image'], 'none');
  return {
    accent: HEX.test(t.accent) ? t.accent.toLowerCase() : '#7c5cff',
    mode: pick(t.mode, ['auto', 'light', 'dark'], 'auto'),
    bg: {
      type: bgType,
      image: bgType === 'image' ? safeImage(bg.image) : '',
      gradient: pick(bg.gradient, GRADIENTS, 'aurora'),
      blur: clamp(bg.blur, 0, 30, 0),
      dim: clamp(bg.dim, 0, 90, 30),
      position: pick(bg.position, ['center', 'top', 'bottom'], 'center'),
    },
    header: {
      subtitle: text(header.subtitle, 200),
      emoji: text(header.emoji, 8),
      banner,
      bannerImage: banner === 'image' ? safeImage(header.bannerImage) : '',
      gradient: pick(header.gradient, GRADIENTS, 'aurora'),
      height: pick(header.height, ['small', 'medium', 'large'], 'medium'),
    },
    cards: {
      layout: pick(cards.layout, ['grid', 'list'], 'grid'),
      size: pick(cards.size, ['small', 'medium', 'large'], 'medium'),
      radius: clamp(cards.radius, 0, 28, 12),
      glass: !!cards.glass,
    },
  };
}

module.exports = { sanitizeTheme, GRADIENTS };

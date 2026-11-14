import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localeDirectory = new URL('../locale/', import.meta.url);

function normalizeLocale(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return Intl.getCanonicalLocales(value.trim())[0].toLowerCase();
  } catch {
    return undefined;
  }
}

function localeChain(value) {
  let locale = normalizeLocale(value);
  const chain = [];
  while (locale) {
    chain.push(locale);
    const boundary = locale.lastIndexOf('-');
    if (boundary === -1) break;
    locale = locale.slice(0, boundary);
    // RFC 4647 lookup removes a trailing extension singleton with its value.
    if (/-[a-z0-9]$/i.test(locale)) locale = locale.slice(0, locale.lastIndexOf('-'));
  }
  return chain;
}

/** Read external dictionaries and the package's default locale configuration. */
export function readLocales(directory = localeDirectory) {
  const root = directory instanceof URL ? fileURLToPath(directory) : directory;
  let config;
  try {
    config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const defaultLocale = normalizeLocale(config?.defaultLocale ?? 'en');
  if (!defaultLocale) throw new Error('invalid-default-locale');
  const locales = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.json') ||
      entry.name.toLowerCase() === 'config.json'
    )
      continue;
    const locale = normalizeLocale(entry.name.slice(0, -5));
    if (!locale) continue;
    if (locales.has(locale)) throw new Error('duplicate-locale');
    const dictionary = JSON.parse(readFileSync(join(root, entry.name), 'utf8'));
    if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary))
      throw new Error('invalid-locale-dictionary');
    locales.set(locale, dictionary);
  }
  return { defaultLocale, locales };
}

/** Resolve a string through the requested BCP 47 chain, then the configured chain. */
export function translate(resources, key, locale = resources.defaultLocale) {
  const keys = key.split('.');
  const candidates = new Set([...localeChain(locale), ...localeChain(resources.defaultLocale)]);
  for (const candidate of candidates) {
    let value = resources.locales.get(candidate);
    for (const part of keys) {
      value =
        value && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined;
    }
    if (typeof value === 'string') return value;
  }
  throw new Error('missing-translation');
}

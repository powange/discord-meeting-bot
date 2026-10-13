import { afterEach, describe, expect, it } from 'vitest';
import { configureSecrets, decryptSecret, encryptSecret, isEncrypted } from '../src/lib/secrets.js';

afterEach(() => configureSecrets(undefined));

describe('clés d’API chiffrées en base', () => {
  it('aller-retour ; chiffré différemment à chaque fois', () => {
    configureSecrets('une-phrase-secrète');
    const a = encryptSecret('sk-123');
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toContain('sk-123');
    expect(encryptSecret('sk-123')).not.toBe(a);
    expect(decryptSecret(a)).toBe('sk-123');
    expect(encryptSecret(a)).toBe(a); // jamais chiffré deux fois
  });

  it('sans clé : stocké en clair ; valeur chiffrée illisible sans la bonne clé', () => {
    expect(encryptSecret('sk-123')).toBe('sk-123');
    expect(decryptSecret('sk-123')).toBe('sk-123');
    configureSecrets('a');
    const stored = encryptSecret('sk-123');
    configureSecrets('b');
    expect(decryptSecret(stored)).toBeNull();
    configureSecrets(undefined);
    expect(decryptSecret(stored)).toBeNull();
    expect(decryptSecret(null)).toBeNull();
  });
});

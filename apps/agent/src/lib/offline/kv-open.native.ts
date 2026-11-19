import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { KV } from './kv';
import { SqlDb, SqliteKV } from './kv-sqlite';

const DB_NAME = 'cablecollect.db';
const KEY_NAME = 'cc.dbKey';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Phone: SQLite (SQLCipher in real builds), key generated once and kept in the Android Keystore. */
export async function openKV(): Promise<KV> {
  let key = await SecureStore.getItemAsync(KEY_NAME);
  if (!key) {
    key = hex(Crypto.getRandomBytes(32));
    await SecureStore.setItemAsync(KEY_NAME, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  const db = (await SQLite.openDatabaseAsync(DB_NAME)) as unknown as SqlDb;
  try {
    return await SqliteKV.open(db, key);
  } catch (e) {
    // The file cannot be read with this key (e.g. app data restored without its Keystore key).
    // Its contents are unreadable either way; start a fresh file rather than staying broken.
    console.warn('Local database unreadable; recreating it', e);
    await (db as unknown as SQLite.SQLiteDatabase).closeAsync().catch(() => undefined);
    await SQLite.deleteDatabaseAsync(DB_NAME);
    return SqliteKV.open((await SQLite.openDatabaseAsync(DB_NAME)) as unknown as SqlDb, key);
  }
}

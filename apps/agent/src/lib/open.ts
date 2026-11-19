import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

/**
 * Opens WhatsApp, maps or a receipt link. On the phone this hands over to the other app; in the
 * web build it opens a new tab (expo-linking would replace the app page and lose its state).
 */
export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await Linking.openURL(url);
}

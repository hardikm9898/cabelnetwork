import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../lib/app-state';
import { PinPad } from '../components/PinPad';
import { Button, C, T } from '../components/ui';

export default function Unlock() {
  const { unlock, unlockWithBiometrics, signOut, t } = useApp();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [bio, setBio] = useState(false);

  const tryBiometrics = useCallback(async () => {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: t('appName'), cancelLabel: t('back') });
    if (r.success) await unlockWithBiometrics();
  }, [t, unlockWithBiometrics]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    void (async () => {
      const ok = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
      setBio(ok);
      if (ok) void tryBiometrics();
    })();
  }, [tryBiometrics]);

  useEffect(() => {
    if (pin.length !== 4) return;
    void (async () => {
      const r = await unlock(pin);
      setPin('');
      if (r.startsWith('wrong:')) setMessage(`${t('wrongPin')} (${r.split(':')[1]})`);
      if (r === 'locked') setMessage(t('pinLocked'));
    })();
  }, [pin, unlock, t]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.canvas, justifyContent: 'center', padding: 20, gap: 24 }}>
      <View style={{ alignItems: 'center', gap: 6 }}>
        <T size={24} weight="800" style={{ color: C.brand }}>
          {t('appName')}
        </T>
        <T size={18}>{t('enterPin')}</T>
        {message && <T style={{ color: C.danger }}>{message}</T>}
      </View>
      <PinPad value={pin} onChange={setPin} />
      <View style={{ gap: 10 }}>
        {bio && <Button title={t('useFingerprint')} variant="secondary" onPress={tryBiometrics} />}
        <Button title={t('forgotPin')} variant="secondary" onPress={signOut} />
      </View>
    </SafeAreaView>
  );
}

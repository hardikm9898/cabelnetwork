import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../lib/app-state';
import { PinPad } from '../components/PinPad';
import { C, Screen, T } from '../components/ui';

export default function SetPin() {
  const { createPin, t } = useApp();
  const [first, setFirst] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pin.length !== 4) return;
    if (first === null) {
      setFirst(pin);
      setPin('');
      setError(null);
    } else if (pin === first) {
      void createPin(pin);
    } else {
      setFirst(null);
      setPin('');
      setError(t('pinMismatch'));
    }
  }, [pin, first, createPin, t]);

  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: 8, paddingVertical: 12 }}>
        <T size={20} weight="700">
          {first === null ? t('setPin') : t('confirmPin')}
        </T>
        <T muted>{t('setPinHint')}</T>
        {error && <T style={{ color: C.danger }}>{error}</T>}
      </View>
      <PinPad value={pin} onChange={setPin} />
    </Screen>
  );
}

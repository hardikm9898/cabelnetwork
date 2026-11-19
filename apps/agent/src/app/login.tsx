import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../lib/app-state';
import { Button, C, Chips, ErrorBox, Field, T } from '../components/ui';

export default function Login() {
  const { signIn, t, lang, setLang } = useApp();
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(mobile.trim(), password);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.brand }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 20, padding: 20, gap: 14 }}>
          <T size={24} weight="800">
            {t('appName')}
          </T>
          <Chips
            value={lang}
            onChange={setLang}
            options={[
              { value: 'en', label: 'English' },
              { value: 'gu', label: 'ગુજરાતી' },
            ]}
          />
          <Field label={t('mobile')} value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={13} />
          <Field label={t('password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={submit} />
          <ErrorBox error={error} />
          <Button testID="sign-in" title={busy ? t('signingIn') : t('signIn')} busy={busy} disabled={!mobile || !password} onPress={submit} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

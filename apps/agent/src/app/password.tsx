import { router } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { useApp } from '../lib/app-state';
import { PasswordForm } from '../components/PasswordForm';

/** Voluntary password change from Profile. The server keeps this session and signs out the others. */
export default function Password() {
  const { t } = useApp();
  const done = () => {
    if (Platform.OS === 'web') window.alert(t('passwordChanged'));
    else Alert.alert(t('changePassword'), t('passwordChanged'));
    router.back();
  };
  return <PasswordForm intro={t('passwordRules')} currentLabel={t('yourPassword')} onDone={done} />;
}

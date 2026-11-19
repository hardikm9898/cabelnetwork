import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { useApp } from '../lib/app-state';
import { API_URL } from '../lib/api';
import { useOffline } from '../lib/offline';
import { Button, C, Card, Chips, Row, Screen, T } from '../components/ui';

export default function Profile() {
  const { me, t, lang, setLang, signOut } = useApp();
  const { store } = useOffline();
  const [confirming, setConfirming] = useState(false);
  const unsent = store.pending().length;
  const storage = store.kv.info();

  const onSignOut = () => {
    // Entries stay on the phone either way, but the agent should send them first.
    if (unsent > 0 && !confirming) return setConfirming(true);
    void signOut();
  };

  return (
    <Screen>
      <Card>
        <T size={18} weight="700">
          {me?.fullName}
        </T>
        <T muted>
          {me?.agentCode} · {me?.mobile}
        </T>
        <T size={13} style={{ color: storage.encrypted ? C.success : C.warning }}>
          {storage.encrypted ? t('storageEncrypted') : t('storageNotEncrypted')}
        </T>
      </Card>
      <T weight="600">{t('language')}</T>
      <Chips
        testIDPrefix="lang"
        value={lang}
        onChange={setLang}
        options={[
          { value: 'en', label: 'English' },
          { value: 'gu', label: 'ગુજરાતી' },
        ]}
      />
      <Button title={t('sync')} variant="secondary" onPress={() => router.push('/sync')} />
      <Button testID="change-password" title={t('changePassword')} variant="secondary" onPress={() => router.push('/password')} />
      {confirming && (
        <T testID="unsent-warning" style={{ color: C.danger }}>
          {unsent} {t('entries')}: {t('unsentBeforeSignOut')}
        </T>
      )}
      <Button testID="sign-out" title={confirming ? t('signOutAnyway') : t('signOut')} variant="danger" onPress={onSignOut} />
      <Row>
        <T muted size={12}>
          {t('version')} {Constants.expoConfig?.version}
        </T>
        <T muted size={12}>
          {API_URL || 'same origin'}
        </T>
      </Row>
    </Screen>
  );
}

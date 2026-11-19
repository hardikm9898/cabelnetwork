import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { View } from 'react-native';
import { businessDateOf, formatDateIN } from '@cablenet/domain';
import { useApp } from '../lib/app-state';
import { useActions, useOffline } from '../lib/offline';
import { isHidden } from '../lib/offline/view';
import { telUrl } from '../lib/share';
import { Button, C, Card, Row, Screen, T, useOnline } from '../components/ui';

/** Open follow-ups for the agent's customers (works offline; "Done" is sent with the next sync). */
export default function FollowUps() {
  const { t } = useApp();
  const online = useOnline();
  const { store } = useOffline();
  const act = useActions(online);
  const header = store.getHeader();
  const today = businessDateOf(new Date());
  const done = new Set(store.getOps().filter((o) => o.type === 'FOLLOWUP_DONE' && o.state !== 'REJECTED').map((o) => String(o.payload.followUpId)));
  const tasks = (header?.followUps ?? [])
    .filter((f) => !done.has(f.id))
    .map((f) => ({ ...f, customer: store.getCustomer(f.customerId) }))
    .filter((f) => f.customer && !isHidden(f.customer, new Date()));

  return (
    <Screen>
      {tasks.length === 0 && <T muted style={{ textAlign: 'center', padding: 24 }}>{t('noFollowUps')}</T>}
      {tasks.map((task) => {
        const c = task.customer!;
        const overdue = task.dueDate < today;
        return (
          <Card key={task.id} onPress={() => router.push({ pathname: '/customers/[id]', params: { id: c.id } })} accessibilityLabel={c.name}>
            <Row>
              <T weight="700" style={overdue ? { color: C.danger } : undefined}>
                {formatDateIN(task.dueDate)}
              </T>
              <T muted size={13}>
                {c.customerCode}
              </T>
            </Row>
            <T size={16} weight="600">
              {c.name}
            </T>
            <T muted size={13}>
              {c.society}
            </T>
            <T>{task.title}</T>
            <Row style={{ gap: 10 }}>
              {c.mobile && (
                <View style={{ flex: 1 }}>
                  <Button title={t('call')} variant="secondary" onPress={() => Linking.openURL(telUrl(c.mobile!))} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Button testID={`followup-done-${c.customerCode}`} title={t('markDone')} variant="secondary" onPress={() => void act.completeFollowUp(task.id, c)} />
              </View>
            </Row>
          </Card>
        );
      })}
    </Screen>
  );
}

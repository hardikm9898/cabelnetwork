import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiError } from '../lib/api';
import { AppStateProvider, useApp } from '../lib/app-state';
import { OfflineProvider, useAutoSync } from '../lib/offline';
import { C, Loading, useOnline } from '../components/ui';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

function Navigator() {
  const { status, t } = useApp();
  const online = useOnline();
  useAutoSync(status === 'ready', online);
  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync();
  }, [status]);
  if (status === 'loading') return <Loading />;

  const header = { headerStyle: { backgroundColor: C.brand }, headerTintColor: '#fff', headerTitleStyle: { fontWeight: '700' as const } };
  return (
    <Stack screenOptions={header}>
      <Stack.Protected guard={status === 'anonymous'}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={status === 'needsPassword'}>
        <Stack.Screen name="change-password" options={{ title: t('newPassword'), headerBackVisible: false }} />
      </Stack.Protected>
      <Stack.Protected guard={status === 'needsPin'}>
        <Stack.Screen name="set-pin" options={{ title: t('setPin'), headerBackVisible: false }} />
      </Stack.Protected>
      <Stack.Protected guard={status === 'locked'}>
        <Stack.Screen name="unlock" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={status === 'ready'}>
        <Stack.Screen name="index" options={{ title: t('appName') }} />
        <Stack.Screen name="customers/index" options={{ title: t('todaysList') }} />
        <Stack.Screen name="customers/[id]" options={{ title: '' }} />
        <Stack.Screen name="collect/[id]" options={{ title: t('collectPayment') }} />
        <Stack.Screen name="visit/[id]" options={{ title: t('recordVisit') }} />
        <Stack.Screen name="edit-customer/[id]" options={{ title: t('editCustomer') }} />
        <Stack.Screen name="delete-payment" options={{ title: t('deletePayment') }} />
        <Stack.Screen name="receipt/[id]" options={{ title: t('receipt'), headerBackVisible: false }} />
        <Stack.Screen name="followups" options={{ title: t('followUps') }} />
        <Stack.Screen name="collections" options={{ title: t('myCollections') }} />
        <Stack.Screen name="cash" options={{ title: t('cashHandover') }} />
        <Stack.Screen name="profile" options={{ title: t('profile') }} />
        <Stack.Screen name="sync" options={{ title: t('sync') }} />
        <Stack.Screen name="password" options={{ title: t('changePassword') }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AppStateProvider>
          <StatusBar style="light" />
          <OfflineProvider fallback={<Loading />}>
            <Navigator />
          </OfflineProvider>
        </AppStateProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

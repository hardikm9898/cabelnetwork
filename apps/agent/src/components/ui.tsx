import { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNetworkState } from 'expo-network';
import { formatInr } from '@cablenet/domain';
import { useApp } from '../lib/app-state';

/** Design tokens (match the admin web brand). Large touch targets for one-handed field use. */
export const C = {
  brand: '#0f766e',
  brandDark: '#115e59',
  brandSoft: '#f0fdfa',
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  canvas: '#f6f7f9',
  surface: '#ffffff',
  danger: '#b42318',
  dangerSoft: '#fef3f2',
  warning: '#b54708',
  warningSoft: '#fffaeb',
  success: '#067647',
  successSoft: '#ecfdf3',
  info: '#175cd3',
  infoSoft: '#eff8ff',
};
export const TOUCH = 52;

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const body = <View style={[{ gap: 12 }, padded && { padding: 16 }]}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.canvas }} edges={['bottom', 'left', 'right']}>
      <OfflineBanner />
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView> : <View style={{ flex: 1 }}>{body}</View>}
    </SafeAreaView>
  );
}

/** Shown whenever the phone has no internet (entries are saved on the phone meanwhile). */
export function OfflineBanner() {
  const net = useNetworkState();
  const { t } = useApp();
  if (net.isConnected !== false && net.isInternetReachable !== false) return null;
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: C.warningSoft, padding: 10, borderBottomWidth: 1, borderColor: '#fedf89' }}>
      <T style={{ color: C.warning, fontWeight: '600' }}>{t('offline')}</T>
    </View>
  );
}

export function useOnline(): boolean {
  const net = useNetworkState();
  return net.isConnected !== false && net.isInternetReachable !== false;
}

export function T({ children, style, size = 15, weight, muted, numberOfLines, testID }: { children: ReactNode; style?: TextStyle | TextStyle[]; size?: number; weight?: TextStyle['fontWeight']; muted?: boolean; numberOfLines?: number; testID?: string }) {
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[{ fontSize: size, color: muted ? C.muted : C.ink, fontWeight: weight }, style as TextStyle]}>
      {children}
    </Text>
  );
}

export function Money({ value, size = 15, color, weight = '600' }: { value: string | null | undefined; size?: number; color?: string; weight?: TextStyle['fontWeight'] }) {
  return (
    <Text style={{ fontSize: size, fontWeight: weight, color: color ?? C.ink, fontVariant: ['tabular-nums'] }}>{value ? formatInr(value) : '—'}</Text>
  );
}

export function Card({ children, style, onPress, accessibilityLabel, testID }: { children: ReactNode; style?: ViewStyle; onPress?: () => void; accessibilityLabel?: string; testID?: string }) {
  const s = [styles.card, style];
  if (!onPress) return <View testID={testID} style={s}>{children}</View>;
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={({ pressed }) => [...s, pressed && { opacity: 0.75 }]}>
      {children}
    </Pressable>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';
export function Button({ title, onPress, variant = 'primary', busy, disabled, icon, testID }: { title: string; onPress: () => void; variant?: Variant; busy?: boolean; disabled?: boolean; icon?: string; testID?: string }) {
  const bg = variant === 'primary' ? C.brand : variant === 'danger' ? C.danger : C.surface;
  const fg = variant === 'secondary' ? C.ink : '#ffffff';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: variant === 'secondary' ? C.line : bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: 16, fontWeight: '700' }}>{icon ? `${icon}  ${title}` : title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, hint, ...input }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: C.ink }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#94a3b8"
        {...input}
        style={[styles.input, error ? { borderColor: C.danger } : null, input.style as TextStyle]}
      />
      {error ? <Text style={{ color: C.danger, fontSize: 13 }}>{error}</Text> : hint ? <Text style={{ color: C.muted, fontSize: 13 }}>{hint}</Text> : null}
    </View>
  );
}

/** Horizontal scrolling chips (filters, quick amounts, quick dates). */
export function Chips<V extends string>({ options, value, onChange, testIDPrefix }: { options: { value: V; label: string; count?: number }[]; value: V | null; onChange: (v: V) => void; testIDPrefix?: string }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            testID={testIDPrefix ? `${testIDPrefix}-${o.value}` : undefined}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.chip, active && { backgroundColor: C.brand, borderColor: C.brand }]}
          >
            <Text style={{ color: active ? '#fff' : C.ink, fontWeight: '600' }}>
              {o.label}
              {o.count !== undefined ? ` (${o.count})` : ''}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  const colors = {
    neutral: ['#f1f5f9', '#334155'],
    good: [C.successSoft, C.success],
    warn: [C.warningSoft, C.warning],
    bad: [C.dangerSoft, C.danger],
    info: ['#eff8ff', '#175cd3'],
  }[tone];
  return (
    <View style={{ backgroundColor: colors[0], borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color: colors[1], fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useApp();
  if (!error) return null;
  const message = error instanceof Error && error.message ? error.message : t('errorGeneric');
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: C.dangerSoft, borderRadius: 12, padding: 12, gap: 8 }}>
      <Text style={{ color: C.danger }}>{message}</Text>
      {onRetry && <Button title={t('retry')} variant="secondary" onPress={onRetry} />}
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ padding: 32, alignItems: 'center' }}>
      <ActivityIndicator color={C.brand} size="large" />
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.line, padding: 14, gap: 8 },
  button: { minHeight: TOUCH, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, backgroundColor: C.surface, color: C.ink },
  chip: { minHeight: 40, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, backgroundColor: C.surface },
});

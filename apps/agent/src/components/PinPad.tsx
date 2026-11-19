import { Pressable, Text, View } from 'react-native';
import { C } from './ui';

/** Large numeric keypad (one-handed use). Shows dots, never digits. */
export function PinPad({ value, onChange, length = 4 }: { value: string; onChange: (v: string) => void; length?: number }) {
  const press = (k: string) => {
    if (k === '⌫') onChange(value.slice(0, -1));
    else if (value.length < length) onChange(value + k);
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return (
    <View style={{ gap: 20, alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', gap: 16 }} accessibilityLabel={`${value.length} of ${length} digits entered`}>
        {Array.from({ length }, (_, i) => (
          <View key={i} style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: C.brand, backgroundColor: i < value.length ? C.brand : 'transparent' }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 280, justifyContent: 'center', gap: 12 }}>
        {keys.map((k, i) =>
          k === '' ? (
            <View key={i} style={{ width: 80, height: 64 }} />
          ) : (
            <Pressable
              key={i}
              testID={`pin-${k === '⌫' ? 'back' : k}`}
              accessibilityRole="button"
              accessibilityLabel={k === '⌫' ? 'Delete' : k}
              onPress={() => press(k)}
              style={({ pressed }) => ({ width: 80, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.brandSoft : '#fff', borderWidth: 1, borderColor: C.line })}
            >
              <Text style={{ fontSize: 26, fontWeight: '600', color: C.ink }}>{k}</Text>
            </Pressable>
          ),
        )}
      </View>
    </View>
  );
}

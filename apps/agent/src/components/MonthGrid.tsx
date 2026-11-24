import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatDateIN, formatInr, monthCalendar, monthName, type MonthBill, type MonthCell, type MonthState } from '@cablenet/domain';
import { useApp } from '../lib/app-state';
import type { Key } from '../lib/i18n';
import { C, Card, Row, T } from './ui';

const LOOK: Record<MonthState, { bg: string; fg: string; border: string; icon: string; key: Key }> = {
  PAID: { bg: C.successSoft, fg: C.success, border: '#abefc6', icon: '✓', key: 'monthPaid' },
  PARTIAL: { bg: C.warningSoft, fg: C.warning, border: '#fedf89', icon: '½', key: 'monthPartial' },
  DUE: { bg: C.dangerSoft, fg: C.danger, border: '#fecdca', icon: '✗', key: 'monthDue' },
  NOT_BILLED: { bg: '#f8fafc', fg: C.muted, border: C.line, icon: '–', key: 'monthNotBilled' },
  UPCOMING: { bg: '#f8fafc', fg: '#94a3b8', border: C.line, icon: '·', key: 'monthUpcoming' },
};

/**
 * Calendar of the last 12 months: which months the customer has paid (green), part paid (amber),
 * not paid (red) or that had no bill. Tapping a month shows the bill, what was paid and when.
 */
export function MonthGrid({ bills, today }: { bills: MonthBill[]; today: string }) {
  const { t } = useApp();
  const cells = monthCalendar(bills, today.slice(0, 7), 12, today);
  const [picked, setPicked] = useState<MonthCell | null>(null);
  const counts = { PAID: 0, PARTIAL: 0, DUE: 0 } as Record<string, number>;
  for (const c of cells) if (c.state in counts) counts[c.state]! += 1;

  return (
    <Card testID="month-grid">
      <Row>
        <T weight="700">{t('months')}</T>
        <T muted size={12}>
          {monthName(cells[0]!.month, true)} – {monthName(cells[cells.length - 1]!.month, true)}
        </T>
      </Row>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {cells.map((c) => {
          const look = LOOK[c.state];
          const active = picked?.month === c.month;
          return (
            <Pressable
              key={c.month}
              testID={`month-${c.month}`}
              accessibilityRole="button"
              accessibilityLabel={`${monthName(c.month, true)}: ${t(look.key)}`}
              onPress={() => setPicked(active ? null : c)}
              style={{
                width: '23.5%',
                minHeight: 58,
                borderRadius: 12,
                borderWidth: active ? 2 : 1,
                borderColor: active ? look.fg : look.border,
                backgroundColor: look.bg,
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: 6,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: C.ink }}>{monthName(c.month)}</Text>
              <Text style={{ fontSize: 16, fontWeight: '800', color: look.fg }}>{look.icon}</Text>
              {c.month.endsWith('-01') && <Text style={{ fontSize: 10, color: C.muted }}>{c.month.slice(0, 4)}</Text>}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {(['PAID', 'PARTIAL', 'DUE', 'NOT_BILLED'] as const).map((s) => (
          <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: LOOK[s].bg, borderWidth: 1, borderColor: LOOK[s].fg }} />
            <T size={12} muted>
              {t(LOOK[s].key)}
              {s in counts ? ` (${counts[s]})` : ''}
            </T>
          </View>
        ))}
      </View>
      {picked ? (
        <View testID="month-detail" style={{ backgroundColor: LOOK[picked.state].bg, borderRadius: 12, padding: 10, gap: 4 }}>
          <Row>
            <T weight="700">{monthName(picked.month, true)}</T>
            <T weight="700" style={{ color: LOOK[picked.state].fg }}>
              {t(LOOK[picked.state].key)}
            </T>
          </Row>
          {picked.bill && (
            <>
              <Row>
                <T muted size={14}>
                  {t('billAmount')}
                  {picked.billMonths > 1 ? ` (${picked.billMonths})` : ''}
                </T>
                <T size={14}>{formatInr(picked.bill.total)}</T>
              </Row>
              <Row>
                <T muted size={14}>{t('paidAmount')}</T>
                <T size={14}>{formatInr(picked.bill.paid)}</T>
              </Row>
              {picked.state !== 'PAID' && (
                <Row>
                  <T muted size={14}>{t('balanceLeft')}</T>
                  <T size={14} weight="700" style={{ color: C.danger }}>
                    {formatInr((Number(picked.bill.total) - Number(picked.bill.paid)).toFixed(2))}
                  </T>
                </Row>
              )}
              {picked.bill.paidOn && (
                <Row>
                  <T muted size={14}>{t('paidOn')}</T>
                  <T size={14}>{formatDateIN(picked.bill.paidOn)}</T>
                </Row>
              )}
            </>
          )}
        </View>
      ) : (
        <T muted size={12}>
          {t('tapMonth')}
        </T>
      )}
    </Card>
  );
}

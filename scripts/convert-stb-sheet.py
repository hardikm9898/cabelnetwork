"""
Converts an operator STB sheet (columns: SIR IAL NO, STB NO, NAME, ADDRESS1, PHONE, NEW BOX,
NEW PLAN, MQ) into the customer-list layout the importer reads, so it can be imported with

    import-customers - --cutover YYYY-MM-01 < <output>.xlsx

    python scripts/convert-stb-sheet.py extradata.xlsx extradata-import.xlsx [--rate 350]
                                        [--use-new-box]

- Customer ID = the 6-digit STB NO (the same convention as the main customer list, where the
  STB number is 307070260700 + Customer ID).
- STB number = 307070260700 + Customer ID. The NEW BOX column is only taken as typed with
  --use-new-box; rows where it disagrees are listed so they can be checked.
- Society is read from the address (spelling variants of the same society are merged).
- MQ goes to MQ No; the plan (e.g. HD) goes to Notes.
- --rate: monthly rate for every customer; without it the customers are imported without billing
  and listed under "Needs decision".
"""
import argparse
import re
import sys
from collections import Counter

import openpyxl

PREFIX = '307070260700'
# Society name → pattern on the address letters (A–Z only), covering the spellings in the sheets.
SOCIETIES = {
    'KARNAVATI': r'K(A?R|RA)A?NA?VA?TI',
    'NANDANVAN': r'NANDANVAN',
    'RATNAMANI': r'RATA?NA?MANI',
    'SUNSHINE': r'SUNS(H?INE|AIN)',
}
HEADERS = {'id': r'^STB\s*NO$', 'name': r'^NAME$', 'address': r'^ADDRESS', 'mobile': r'^PHONE|MOBILE', 'box': r'NEW\s*BOX', 'plan': r'PLAN', 'mq': r'^MQ'}


def text(v):
    return re.sub(r'\s+', ' ', str(v)).strip() if v is not None else ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source')
    ap.add_argument('target')
    ap.add_argument('--rate', help='monthly rate for every customer, e.g. 350')
    ap.add_argument('--use-new-box', action='store_true', help='take the STB number from NEW BOX as typed')
    a = ap.parse_args()
    if a.rate is not None and not re.fullmatch(r'\d{1,6}(\.\d{1,2})?', a.rate):
        sys.exit('--rate must be an amount like 350')

    ws = openpyxl.load_workbook(a.source, data_only=True).worksheets[0]
    header = [text(c.value).upper() for c in ws[1]]
    col = {}
    for key, pat in HEADERS.items():
        hit = [i for i, h in enumerate(header) if re.search(pat, h)]
        if not hit:
            sys.exit(f'column for "{key}" not found in the header {header}')
        col[key] = hit[0]

    rows, problems, box_diff = [], [], []
    for n, r in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        get = lambda k: text(r[col[k]]) if col[k] < len(r) else ''
        code = get('id')
        if not code:
            continue
        if not re.fullmatch(r'\d{6}', code):
            problems.append(f'row {n}: STB NO "{code}" is not 6 digits')
            continue
        letters = re.sub('[^A-Z]', '', get('address').upper())
        society = next((s for s, p in SOCIETIES.items() if re.search(p, letters)), None)
        if not society:
            problems.append(f'row {n} ({code}): no society recognised in the address "{get("address")}"')
        stb = PREFIX + code
        if get('box') != stb:
            box_diff.append((n, code, get('name'), get('box')))
            if a.use_new_box:
                stb = get('box')
        rows.append([code, get('name'), get('address'), get('mobile'), float(a.rate) if a.rate else None, stb, get('mq') or None, f'Plan: {get("plan")}' if get('plan') else None, society])

    for k, c in Counter(r[0] for r in rows).items():
        if c > 1:
            problems.append(f'Customer ID {k} appears {c} times')
    for k, c in Counter(r[5] for r in rows).items():
        if c > 1:
            problems.append(f'STB {k} appears {c} times')

    out = openpyxl.Workbook()
    sh = out.active
    sh.title = 'Customer List'
    sh.append(['Customer ID', 'Customer Name', 'Address', 'Mobile', 'Monthly Rate', 'STB No', 'MQ No', 'Notes', 'Society'])
    for r in rows:
        sh.append(r)
    for c in ('A', 'D', 'F', 'G'):
        for cell in sh[c][1:]:
            cell.number_format = '@'  # keep IDs and numbers as text
    out.save(a.target)

    print(f'{len(rows)} customers written to {a.target}')
    for s, c in sorted(Counter(r[8] for r in rows).items(), key=lambda x: str(x[0])):
        print(f'  {c:4}  {s}')
    print(f'rate: {a.rate or "none (imported without billing; Needs decision)"}')
    if box_diff:
        print(f'\nNEW BOX differs from 307070260700 + STB NO in {len(box_diff)} rows '
              f'({"NEW BOX used as typed" if a.use_new_box else "STB NO used; add --use-new-box to take NEW BOX"}):')
        for n, code, name, box in box_diff:
            print(f'  row {n}: {code} {name}: NEW BOX {box}')
    if problems:
        print('\nPROBLEMS:')
        for p in problems:
            print('  ' + p)
        sys.exit(1)


if __name__ == '__main__':
    main()

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBalanceForwardFromText } from '../../src/services/pdfImportService';

// Made-up figures in a city water bill's layout; the penalty sits above BALANCE FORWARD.
const layout = `Previous Balance $600.00
Late Payment Penalty - 10/7/2026 $20.00
BALANCE FORWARD $620.00
TOTAL CURRENT CHARGES $300.00
Balance Forward - Due Upon Receipt $620.00
Current Charges - Due 10/29/2026 $300.00
Total Due $920.00`;
// The same bill as pdf-parse lays it out: amounts before labels, the total away from its label.
const parsed = `Late Payment Penalty - 10/7/2026
$20.00
$620.00BALANCE FORWARD
TOTAL CURRENT CHARGES$300.00
Current ChargesTotal Due
$300.00
Balance Forward
$920.00
$620.00`;

for (const [name, text] of [['layout', layout], ['pdf-parse', parsed]] as const) {
  test(`the printed balance forward and current charges are taken (${name})`, () => {
    const ex: any = { amountDue: 320, currentCharges: 320, previousBalance: 600 };
    applyBalanceForwardFromText(text, ex);
    assert.equal(ex.amountDue, 300);
    assert.equal(ex.previousBalance, 620);
    assert.equal(ex.statedTotalDue, 920);
  });
}

test('figures that do not add up are left alone', () => {
  const ex: any = { amountDue: 320, previousBalance: 600 };
  applyBalanceForwardFromText('BALANCE FORWARD $620.00 TOTAL CURRENT CHARGES $300.00 Total Due $999.99', ex);
  assert.equal(ex.amountDue, 320);
});

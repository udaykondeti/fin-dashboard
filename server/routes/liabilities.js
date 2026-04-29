const express = require('express');
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// All liability routes require authentication
router.use(authMiddleware);

// ─── CREDIT CARDS ─────────────────────────────────────────────────────────────

/**
 * GET /api/liabilities/credit-cards
 */
router.get('/credit-cards', (req, res) => {
  try {
    const cards = db.prepare('SELECT * FROM credit_cards WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ credit_cards: cards });
  } catch (err) {
    console.error('Get credit cards error:', err);
    res.status(500).json({ error: 'Failed to fetch credit cards', message: err.message });
  }
});

/**
 * POST /api/liabilities/credit-cards
 */
router.post('/credit-cards', (req, res) => {
  try {
    const { card_name, bank, card_limit, outstanding_balance, due_date, min_payment, notes } = req.body;

    if (!card_name || !bank || !card_limit) {
      return res.status(400).json({ error: 'card_name, bank, and card_limit are required' });
    }

    const result = db.prepare(`
      INSERT INTO credit_cards (user_id, card_name, bank, card_limit, outstanding_balance, due_date, min_payment, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, card_name, bank, card_limit,
      outstanding_balance || 0, due_date || null,
      min_payment || 0, notes || null
    );

    const card = db.prepare('SELECT * FROM credit_cards WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, credit_card: card });
  } catch (err) {
    console.error('Create credit card error:', err);
    res.status(500).json({ error: 'Failed to create credit card', message: err.message });
  }
});

/**
 * PUT /api/liabilities/credit-cards/:id
 */
router.put('/credit-cards/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM credit_cards WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Credit card not found' });

    const { card_name, bank, card_limit, outstanding_balance, due_date, min_payment, notes } = req.body;

    db.prepare(`
      UPDATE credit_cards SET
        card_name = COALESCE(?, card_name),
        bank = COALESCE(?, bank),
        card_limit = COALESCE(?, card_limit),
        outstanding_balance = COALESCE(?, outstanding_balance),
        due_date = COALESCE(?, due_date),
        min_payment = COALESCE(?, min_payment),
        notes = ?
      WHERE id = ? AND user_id = ?
    `).run(
      card_name || null, bank || null, card_limit || null,
      outstanding_balance !== undefined ? outstanding_balance : null,
      due_date || null,
      min_payment !== undefined ? min_payment : null,
      notes !== undefined ? notes : existing.notes,
      id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM credit_cards WHERE id = ?').get(id);
    res.json({ success: true, credit_card: updated });
  } catch (err) {
    console.error('Update credit card error:', err);
    res.status(500).json({ error: 'Failed to update credit card', message: err.message });
  }
});

/**
 * DELETE /api/liabilities/credit-cards/:id
 */
router.delete('/credit-cards/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM credit_cards WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Credit card not found' });

    db.prepare('DELETE FROM credit_cards WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Credit card deleted' });
  } catch (err) {
    console.error('Delete credit card error:', err);
    res.status(500).json({ error: 'Failed to delete credit card', message: err.message });
  }
});

// ─── LOANS ────────────────────────────────────────────────────────────────────

/**
 * GET /api/liabilities/loans
 */
router.get('/loans', (req, res) => {
  try {
    const loans = db.prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ loans });
  } catch (err) {
    console.error('Get loans error:', err);
    res.status(500).json({ error: 'Failed to fetch loans', message: err.message });
  }
});

/**
 * POST /api/liabilities/loans
 */
router.post('/loans', (req, res) => {
  try {
    const {
      loan_type, lender, principal_amount, outstanding_amount,
      interest_rate, emi_amount, emi_date, start_date, end_date, notes
    } = req.body;

    if (!loan_type || !lender || !principal_amount || !outstanding_amount || !interest_rate || !emi_amount) {
      return res.status(400).json({
        error: 'loan_type, lender, principal_amount, outstanding_amount, interest_rate, and emi_amount are required'
      });
    }

    const result = db.prepare(`
      INSERT INTO loans (user_id, loan_type, lender, principal_amount, outstanding_amount, interest_rate, emi_amount, emi_date, start_date, end_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, loan_type, lender, principal_amount, outstanding_amount,
      interest_rate, emi_amount, emi_date || null, start_date || null, end_date || null, notes || null
    );

    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, loan });
  } catch (err) {
    console.error('Create loan error:', err);
    res.status(500).json({ error: 'Failed to create loan', message: err.message });
  }
});

/**
 * PUT /api/liabilities/loans/:id
 */
router.put('/loans/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM loans WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Loan not found' });

    const {
      loan_type, lender, principal_amount, outstanding_amount,
      interest_rate, emi_amount, emi_date, start_date, end_date, notes
    } = req.body;

    db.prepare(`
      UPDATE loans SET
        loan_type = COALESCE(?, loan_type),
        lender = COALESCE(?, lender),
        principal_amount = COALESCE(?, principal_amount),
        outstanding_amount = COALESCE(?, outstanding_amount),
        interest_rate = COALESCE(?, interest_rate),
        emi_amount = COALESCE(?, emi_amount),
        emi_date = COALESCE(?, emi_date),
        start_date = COALESCE(?, start_date),
        end_date = COALESCE(?, end_date),
        notes = ?
      WHERE id = ? AND user_id = ?
    `).run(
      loan_type || null, lender || null, principal_amount || null, outstanding_amount || null,
      interest_rate || null, emi_amount || null, emi_date || null, start_date || null, end_date || null,
      notes !== undefined ? notes : existing.notes,
      id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    res.json({ success: true, loan: updated });
  } catch (err) {
    console.error('Update loan error:', err);
    res.status(500).json({ error: 'Failed to update loan', message: err.message });
  }
});

/**
 * DELETE /api/liabilities/loans/:id
 */
router.delete('/loans/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM loans WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Loan not found' });

    db.prepare('DELETE FROM loans WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Loan deleted' });
  } catch (err) {
    console.error('Delete loan error:', err);
    res.status(500).json({ error: 'Failed to delete loan', message: err.message });
  }
});

// ─── LIABILITIES SUMMARY ──────────────────────────────────────────────────────

/**
 * GET /api/liabilities/summary
 */
router.get('/summary', (req, res) => {
  try {
    const userId = req.user.id;

    const cards = db.prepare('SELECT * FROM credit_cards WHERE user_id = ?').all(userId);
    const loans = db.prepare('SELECT * FROM loans WHERE user_id = ?').all(userId);

    const totalCreditCardOutstanding = cards.reduce((sum, c) => sum + (c.outstanding_balance || 0), 0);
    const totalLoanOutstanding = loans.reduce((sum, l) => sum + (l.outstanding_amount || 0), 0);
    const totalMonthlyEmi = loans.reduce((sum, l) => sum + (l.emi_amount || 0), 0);
    const totalCreditLimit = cards.reduce((sum, c) => sum + (c.card_limit || 0), 0);

    res.json({
      summary: {
        total_liabilities: Math.round(totalCreditCardOutstanding + totalLoanOutstanding),
        credit_cards: {
          total_outstanding: Math.round(totalCreditCardOutstanding),
          total_limit: Math.round(totalCreditLimit),
          utilization_percent: totalCreditLimit > 0
            ? parseFloat(((totalCreditCardOutstanding / totalCreditLimit) * 100).toFixed(2))
            : 0,
          count: cards.length
        },
        loans: {
          total_outstanding: Math.round(totalLoanOutstanding),
          monthly_emi: Math.round(totalMonthlyEmi),
          count: loans.length
        }
      }
    });
  } catch (err) {
    console.error('Liabilities summary error:', err);
    res.status(500).json({ error: 'Failed to compute liabilities summary', message: err.message });
  }
});

module.exports = router;

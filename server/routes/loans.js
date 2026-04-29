const express = require('express');
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// All loan routes require authentication
router.use(authMiddleware);

// ─── HAND LOANS ───────────────────────────────────────────────────────────────

/**
 * GET /api/loans/hand-loans
 * Optional query: ?direction=given|taken
 */
router.get('/hand-loans', (req, res) => {
  try {
    const { direction, status } = req.query;

    let query = 'SELECT * FROM hand_loans WHERE user_id = ?';
    const params = [req.user.id];

    if (direction && ['given', 'taken'].includes(direction)) {
      query += ' AND direction = ?';
      params.push(direction);
    }

    if (status && ['active', 'settled', 'partial'].includes(status)) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const handLoans = db.prepare(query).all(...params);
    res.json({ hand_loans: handLoans });
  } catch (err) {
    console.error('Get hand loans error:', err);
    res.status(500).json({ error: 'Failed to fetch hand loans', message: err.message });
  }
});

/**
 * POST /api/loans/hand-loans
 */
router.post('/hand-loans', (req, res) => {
  try {
    const { person_name, phone, direction, amount, date, due_date, interest_rate, status, notes } = req.body;

    if (!person_name || !direction || !amount || !date) {
      return res.status(400).json({ error: 'person_name, direction, amount, and date are required' });
    }

    if (!['given', 'taken'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be "given" or "taken"' });
    }

    if (status && !['active', 'settled', 'partial'].includes(status)) {
      return res.status(400).json({ error: 'status must be "active", "settled", or "partial"' });
    }

    const result = db.prepare(`
      INSERT INTO hand_loans (user_id, person_name, phone, direction, amount, date, due_date, interest_rate, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, person_name, phone || null, direction, amount, date,
      due_date || null, interest_rate || 0, status || 'active', notes || null
    );

    const loan = db.prepare('SELECT * FROM hand_loans WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, hand_loan: loan });
  } catch (err) {
    console.error('Create hand loan error:', err);
    res.status(500).json({ error: 'Failed to create hand loan', message: err.message });
  }
});

/**
 * PUT /api/loans/hand-loans/:id
 */
router.put('/hand-loans/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM hand_loans WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Hand loan not found' });

    const { person_name, phone, direction, amount, date, due_date, interest_rate, status, notes } = req.body;

    if (direction && !['given', 'taken'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be "given" or "taken"' });
    }

    if (status && !['active', 'settled', 'partial'].includes(status)) {
      return res.status(400).json({ error: 'status must be "active", "settled", or "partial"' });
    }

    db.prepare(`
      UPDATE hand_loans SET
        person_name = COALESCE(?, person_name),
        phone = COALESCE(?, phone),
        direction = COALESCE(?, direction),
        amount = COALESCE(?, amount),
        date = COALESCE(?, date),
        due_date = COALESCE(?, due_date),
        interest_rate = COALESCE(?, interest_rate),
        status = COALESCE(?, status),
        notes = ?
      WHERE id = ? AND user_id = ?
    `).run(
      person_name || null, phone || null, direction || null, amount || null,
      date || null, due_date || null,
      interest_rate !== undefined ? interest_rate : null,
      status || null,
      notes !== undefined ? notes : existing.notes,
      id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM hand_loans WHERE id = ?').get(id);
    res.json({ success: true, hand_loan: updated });
  } catch (err) {
    console.error('Update hand loan error:', err);
    res.status(500).json({ error: 'Failed to update hand loan', message: err.message });
  }
});

/**
 * DELETE /api/loans/hand-loans/:id
 */
router.delete('/hand-loans/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM hand_loans WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Hand loan not found' });

    db.prepare('DELETE FROM hand_loans WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Hand loan deleted' });
  } catch (err) {
    console.error('Delete hand loan error:', err);
    res.status(500).json({ error: 'Failed to delete hand loan', message: err.message });
  }
});

// ─── LOANS SUMMARY ────────────────────────────────────────────────────────────

/**
 * GET /api/loans/summary
 */
router.get('/summary', (req, res) => {
  try {
    const userId = req.user.id;

    const allLoans = db.prepare('SELECT * FROM hand_loans WHERE user_id = ?').all(userId);
    const activeLoans = allLoans.filter(l => l.status === 'active');

    const givenLoans = activeLoans.filter(l => l.direction === 'given');
    const takenLoans = activeLoans.filter(l => l.direction === 'taken');

    const totalGiven = givenLoans.reduce((sum, l) => sum + l.amount, 0);
    const totalTaken = takenLoans.reduce((sum, l) => sum + l.amount, 0);
    const netPosition = totalGiven - totalTaken;

    // Overdue loans (past due_date and still active)
    const today = new Date().toISOString().split('T')[0];
    const overdueLoans = activeLoans.filter(l => l.due_date && l.due_date < today);

    res.json({
      summary: {
        total_given: Math.round(totalGiven),
        total_taken: Math.round(totalTaken),
        net_position: Math.round(netPosition),
        net_position_label: netPosition >= 0 ? 'net_receivable' : 'net_payable',
        active_count: activeLoans.length,
        settled_count: allLoans.filter(l => l.status === 'settled').length,
        overdue_count: overdueLoans.length,
        given: {
          count: givenLoans.length,
          total: Math.round(totalGiven)
        },
        taken: {
          count: takenLoans.length,
          total: Math.round(totalTaken)
        }
      }
    });
  } catch (err) {
    console.error('Loans summary error:', err);
    res.status(500).json({ error: 'Failed to compute loans summary', message: err.message });
  }
});

module.exports = router;

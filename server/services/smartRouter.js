/**
 * Smart file categorization service.
 * Uses keyword matching on filename + description to suggest the best
 * S3 folder category and subcategory for a financial document.
 */

// Category rules: each entry defines a category, subcategory and the keywords that trigger it.
// Checked in order — first match wins (within each category group).
const CATEGORY_RULES = [
  // ── TAX ──────────────────────────────────────────────────────────────
  {
    category: 'tax',
    subcategory: 'advance-tax',
    keywords: ['advance tax', 'advance-tax', 'self assessment tax', 'challan 280', 'self-assessment tax']
  },
  {
    category: 'tax',
    subcategory: 'tds',
    keywords: ['tds', 'form 16', 'form 26as', 'tax deducted', 'tds certificate', '26as', 'form16', 'form 16a', 'form 16b']
  },
  {
    category: 'tax',
    subcategory: 'itr',
    keywords: ['itr', 'income tax return', 'tax filing', 'acknowledgement', 'itr-1', 'itr-2', 'itr-3', 'itr-4', 'ais', 'annual information statement', 'form 26as']
  },
  {
    category: 'tax',
    subcategory: 'capital-gains',
    keywords: ['capital gains', 'stcg', 'ltcg', 'short term capital', 'long term capital', 'section 112a', '111a', 'schedule cg']
  },
  {
    category: 'tax',
    subcategory: 'gst',
    keywords: ['gst', 'goods and services', 'gstr', 'gstin']
  },

  // ── STOCKS ────────────────────────────────────────────────────────────
  {
    category: 'stocks',
    subcategory: 'nse-bse',
    keywords: ['nse', 'bse', 'equity', 'shares', 'demat', 'contract note', 'dp statement', 'zerodha', 'groww', 'upstox', 'trade confirmation']
  },
  {
    category: 'stocks',
    subcategory: 'dividends',
    keywords: ['dividend', 'interim dividend', 'final dividend', 'dividend warrant', 'dividend credit']
  },

  // ── MUTUAL FUNDS ──────────────────────────────────────────────────────
  {
    category: 'mutual-funds',
    subcategory: 'elss',
    keywords: ['elss', 'tax saving', '80c', 'section 80c', 'tax saver fund']
  },
  {
    category: 'mutual-funds',
    subcategory: 'sip',
    keywords: ['sip', 'systematic investment', 'mutual fund', 'mf statement', 'cams', 'karvy', 'kfintech', 'folio', 'nav', 'redemption', 'switch']
  },
  {
    category: 'mutual-funds',
    subcategory: 'capital-gains',
    keywords: ['capital gains statement', 'p&l statement', 'profit and loss statement', 'realized gains', 'realised gains', 'cg statement']
  },

  // ── FIXED DEPOSITS ────────────────────────────────────────────────────
  {
    category: 'fixed-deposits',
    subcategory: 'fd',
    keywords: ['fd receipt', 'fixed deposit', 'fd certificate', 'renewal', 'term deposit', 'fdr']
  },
  {
    category: 'fixed-deposits',
    subcategory: 'tax-saver-fd',
    keywords: ['tax saver fd', '5 year fd', '80c fd', 'tax saving fd', 'tax saving fixed deposit']
  },
  {
    category: 'fixed-deposits',
    subcategory: 'rd',
    keywords: ['rd', 'recurring deposit', 'recurring']
  },

  // ── LOANS ─────────────────────────────────────────────────────────────
  {
    category: 'loans',
    subcategory: 'home-loan',
    keywords: ['home loan', 'housing loan', 'property loan', 'emi statement', 'home loan statement', 'mortgage']
  },
  {
    category: 'loans',
    subcategory: 'car-loan',
    keywords: ['car loan', 'vehicle loan', 'auto loan', 'car finance']
  },
  {
    category: 'loans',
    subcategory: 'personal-loan',
    keywords: ['personal loan']
  },
  {
    category: 'loans',
    subcategory: 'interest-cert',
    keywords: ['interest certificate', 'provisional certificate', 'housing loan certificate', 'provisional interest']
  },

  // ── INSURANCE ─────────────────────────────────────────────────────────
  {
    category: 'insurance',
    subcategory: 'life',
    keywords: ['life insurance', 'lic', 'term plan', 'premium receipt', 'life cover', 'term insurance', 'endowment']
  },
  {
    category: 'insurance',
    subcategory: 'health',
    keywords: ['health insurance', 'mediclaim', 'medi-claim', 'health policy', 'star health', 'niva bupa', 'care health']
  },
  {
    category: 'insurance',
    subcategory: 'general',
    keywords: ['general insurance', 'vehicle insurance', 'car insurance', 'bike insurance', 'two-wheeler insurance', 'property insurance']
  },

  // ── US STOCKS ─────────────────────────────────────────────────────────
  {
    category: 'us-stocks',
    subcategory: 'us',
    keywords: ['us stocks', 'nasdaq', 'nyse', '1099', 'foreign stocks', 'drivewealth', 'ibkr', 'interactive brokers', 'indmoney', 'vested', 'us equity']
  },

  // ── 80C SAVINGS INSTRUMENTS ───────────────────────────────────────────
  {
    category: 'tax',
    subcategory: '80c-ppf',
    keywords: ['ppf', 'public provident fund', 'ppf statement', 'ppf passbook', 'ppf account']
  },
  {
    category: 'tax',
    subcategory: '80c-nsc',
    keywords: ['nsc', 'national savings certificate', 'nsc certificate']
  },
  {
    category: 'tax',
    subcategory: '80c-sukanya',
    keywords: ['sukanya', 'sukanya samriddhi', 'ssys', 'ssy account']
  },
  {
    category: 'tax',
    subcategory: '80c-scss',
    keywords: ['scss', 'senior citizen savings scheme', 'senior savings scheme']
  },

  // ── RECEIPTS ──────────────────────────────────────────────────────────
  {
    category: 'receipts',
    subcategory: 'medical',
    keywords: ['medical', 'hospital', 'pharmacy', 'doctor', 'prescription', 'clinic', 'pathology', 'diagnostic', 'lab report']
  },
  {
    category: 'receipts',
    subcategory: 'preventive-health',
    keywords: ['preventive health', 'preventive checkup', 'health checkup', 'annual health checkup', 'master health checkup', '80d checkup']
  },
  {
    category: 'receipts',
    subcategory: 'donations',
    keywords: ['donation', '80g', 'charity', 'ngo', 'trust', '80-g', 'section 80g']
  },
  {
    category: 'receipts',
    subcategory: 'rent',
    keywords: ['rent receipt', 'house rent', 'hra', 'rental receipt', 'rent agreement', 'lease agreement']
  },
  {
    category: 'receipts',
    subcategory: 'tuition',
    keywords: ['tuition fees', 'school fees', 'college fees', 'education fees', 'fee receipt']
  }
];

/**
 * Maps linkedType values (from the frontend page context) to a default category.
 */
const LINKED_TYPE_CATEGORY_MAP = {
  stock: 'stocks',
  stocks: 'stocks',
  'mutual-fund': 'mutual-funds',
  'mutual_fund': 'mutual-funds',
  mutualfund: 'mutual-funds',
  fd: 'fixed-deposits',
  'fixed-deposit': 'fixed-deposits',
  'fixed_deposit': 'fixed-deposits',
  fixeddeposit: 'fixed-deposits',
  loan: 'loans',
  'home-loan': 'loans',
  'car-loan': 'loans',
  'personal-loan': 'loans',
  insurance: 'insurance',
  'us-stock': 'us-stocks',
  'us_stock': 'us-stocks',
  usstock: 'us-stocks',
  tax: 'tax',
  receipt: 'receipts'
};

/**
 * Normalizes text for matching: lowercases and trims.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return (text || '').toLowerCase().trim();
}

/**
 * Checks whether any keyword appears in the combined search text.
 * @param {string[]} keywords
 * @param {string} searchText - already normalized
 * @returns {string|null} the matched keyword, or null
 */
function findMatch(keywords, searchText) {
  for (const kw of keywords) {
    if (searchText.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}

/**
 * Classifies a document based on its filename, description, and optional linked entity context.
 *
 * @param {string} filename        - Original file name (e.g. "TDS_Certificate_2025.pdf")
 * @param {string} description     - User-provided description
 * @param {string} linkedType      - Type of entity this file is linked to (e.g. "stock", "fd")
 * @param {string|number} linkedId - ID of the linked entity (unused in classification, passed through)
 * @returns {{ category: string, subcategory: string, confidence: 'high'|'medium'|'low', reason: string, suggestedPath: string }}
 */
function classifyDocument(filename, description, linkedType, linkedId) {
  const searchText = normalize(`${filename} ${description}`);

  // 1. Try keyword matching on filename + description
  for (const rule of CATEGORY_RULES) {
    const matched = findMatch(rule.keywords, searchText);
    if (matched) {
      return {
        category: rule.category,
        subcategory: rule.subcategory,
        confidence: 'high',
        reason: `Keyword match: "${matched}" found in filename/description`,
        suggestedPath: `${rule.category}/${rule.subcategory}/`
      };
    }
  }

  // 2. Fall back to linkedType mapping if keyword matching failed
  if (linkedType) {
    const mappedCategory = LINKED_TYPE_CATEGORY_MAP[normalize(linkedType)];
    if (mappedCategory) {
      // Find the first subcategory for this category as a default
      const defaultSubcat = CATEGORY_RULES.find(r => r.category === mappedCategory);
      const subcategory = defaultSubcat ? defaultSubcat.subcategory : 'other';
      return {
        category: mappedCategory,
        subcategory,
        confidence: 'medium',
        reason: `Classified based on linked entity type: "${linkedType}"`,
        suggestedPath: `${mappedCategory}/${subcategory}/`
      };
    }
  }

  // 3. Default fallback
  return {
    category: 'receipts',
    subcategory: 'other',
    confidence: 'low',
    reason: 'No keywords matched; defaulting to receipts/other',
    suggestedPath: 'receipts/other/'
  };
}

module.exports = { classifyDocument };

import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const TABS = [
  { to: '/dashboard',    label: 'Dashboard'      },
  { to: '/investments',  label: 'Investments'    },
  { to: '/liabilities',  label: 'Liabilities'    },
  { to: '/handloans',    label: 'Hand Loans'     },
  { to: '/earnings',     label: '💰 Earnings'    },
  { to: '/payments',     label: '📅 Payments'    },
  { to: '/properties',   label: '🏠 Properties'  },
  { to: '/incometax',    label: '📋 Income Tax'  },
  { to: '/vault',        label: '📁 Vault'       },
  { to: '/agent',        label: '🤖 Agent'       },
  { to: '/analytics',    label: 'Analytics'      }
];

export function TopNav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <nav className="border-b border-latte bg-cream/95 backdrop-blur sticky top-0 z-40">
      <div className="max-w-[1400px] mx-auto px-4 h-14 flex items-center gap-4">
        <div className="font-bold text-espresso text-lg flex items-center gap-1.5">
          <span>💰</span> FinDash
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider text-caramel bg-caramel/10 border border-caramel/30 rounded px-1.5 py-0.5">v2</span>
        </div>
        <div className="hidden lg:flex items-center gap-0.5 overflow-x-auto flex-1">
          {TABS.map(t => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                `whitespace-nowrap text-xs px-3 py-1.5 rounded-md transition-colors ${
                  isActive ? 'bg-caramel text-cream font-semibold' : 'text-mocha hover:bg-latte/50'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-mocha hidden md:inline">{user?.name || 'User'}</span>
          <button
            onClick={() => { logout(); navigate('/login'); }}
            className="text-xs px-3 py-1.5 rounded-md border border-latte text-mocha hover:bg-latte/50"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}

import { useState, useEffect, CSSProperties, FormEvent, useRef } from "react";
import { auth, db } from "./firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  User,
} from "firebase/auth";
import { ref, set, onValue, update } from "firebase/database";
import { MoreVertical, Trash2, Menu } from "lucide-react";
import { z } from "zod";

// --- CLIENT-SIDE ZERO-TRUST SCHEMA ---
const deliveryEntrySchema = z.object({
  count: z.number().int().nonnegative().max(100000),
  pricePerPiece: z.number().nonnegative().max(100000),
});

const deliveryLogSchema = z.object({
  count: z.number().int().nonnegative().max(1000000),
  pricePerPiece: z.number().nonnegative().max(100000),
  earnings: z.number().nonnegative().max(200000000).optional(),
  entries: z.array(deliveryEntrySchema).optional(),
});

// Dates must be in YYYY-MM-DD format
const deliveryLogsSchema = z.record(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deliveryLogSchema
);

// Define TypeScript interfaces
interface DeliveryEntry {
  count: number;
  pricePerPiece: number;
}
interface DeliveryLog {
  count: number;
  pricePerPiece: number;
  earnings?: number;
  entries?: DeliveryEntry[];
}

interface DeliveryLogs {
  [date: string]: DeliveryLog;
}

function safeParseDeliveryLogs(raw: string): DeliveryLogs {
  if (!raw) return {};
  try {
    const rawParsed = JSON.parse(raw);
    const result = deliveryLogsSchema.safeParse(rawParsed);
    if (result.success) {
      return result.data;
    } else {
      console.warn("Telemetry warn: Corrupt logs structure blocked by client schema validation", result.error);
    }
  } catch (e) {
    console.error("Critical: Failed to decode sync JSON stream", e);
  }
  return {};
}

const BANGLA_DAYS = [
  "রবিবার",
  "সোমবার",
  "মঙ্গলবার",
  "বুধবার",
  "বৃহস্পতিবার",
  "শুক্রবার",
  "শনিবার",
];

const BANGLA_MONTHS = [
  "জানুয়ারি",
  "ফেব্রুয়ারি",
  "মার্চ",
  "এপ্রিল",
  "মে",
  "জুন",
  "জুলাই",
  "আগস্ট",
  "সেপ্টেম্বর",
  "অক্টোবর",
  "নভেম্বর",
  "ডিসেম্বর",
];

function toBanglaNum(n: string | number): string {
  return String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]);
}

function todayKey(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${toBanglaNum(d.getDate())} ${BANGLA_MONTHS[d.getMonth()]} ${toBanglaNum(
    d.getFullYear()
  )}`;
}

function getEarnings(log: DeliveryLog): number {
  if (log.entries && log.entries.length > 0) {
    return log.entries.reduce((sum, e) => sum + e.count * (e.pricePerPiece || 0), 0);
  }
  return (log.count || 0) * (log.pricePerPiece || 0);
}

const SplashScreen = () => (
  <div
    style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "#0a0f1e",
    }}
  >
    <div
      style={{
        fontSize: "70px",
        animation: "pulse 1.5s infinite ease-in-out",
      }}
    >
      📦
    </div>
    <div
      style={{
        color: "#64ffda",
        marginTop: "20px",
        fontSize: "20px",
        fontWeight: "bold",
        letterSpacing: "1px",
      }}
    >
      Delivery Tracker
    </div>
  </div>
);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [logs, setLogs] = useState<DeliveryLogs>({});
  const [pricePerPiece, setPricePerPiece] = useState(30);
  const [priceInput, setPriceInput] = useState("30");
  const [view, setView] = useState("home");
  const [isPressed, setIsPressed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [deleteTargetDate, setDeleteTargetDate] = useState<string | null>(null);
  const [activeMenuDate, setActiveMenuDate] = useState<string | null>(null);

  // Connection and Synchronization states
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastClickTimeRef = useRef<number>(0);

  // Monitor online/offline state
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, []);

  // Trigger sync of logs and price to Firebase DB
  const triggerSync = async (uid: string, currentLogs: DeliveryLogs, currentPrice: number, showVisualSyncState = true) => {
    if (!navigator.onLine) return;
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    if (showVisualSyncState) {
      setSyncing(true);
    }
    
    // Run the Firebase update in the background asynchronously so it never blocks the UI
    update(ref(db, `users/${uid}`), {
      delivery_logs: JSON.stringify(currentLogs),
      price_per_piece: String(currentPrice),
    }).then(() => {
      localStorage.setItem(`needs_sync_${uid}`, "false");
    }).catch((err) => {
      console.error("Firebase sync deferred:", err);
    });

    if (showVisualSyncState) {
      // Just wait 120 milliseconds to give a crisp visual confirmation, then immediately return to "online" state
      syncTimeoutRef.current = setTimeout(() => {
        setSyncing(false);
        syncTimeoutRef.current = null;
      }, 120);
    }
  };

  const saveLogsLocallyAndSync = (updatedLogs: DeliveryLogs) => {
    const validation = deliveryLogsSchema.safeParse(updatedLogs);
    if (!validation.success) {
      console.error("Telemetry error: Attempted corrupted save blocked", validation.error);
      return;
    }
    const cleanLogs = validation.data;
    setLogs(cleanLogs);
    if (user) {
      localStorage.setItem(`delivery_logs_${user.uid}`, JSON.stringify(cleanLogs));
      localStorage.setItem(`needs_sync_${user.uid}`, "true");
      triggerSync(user.uid, cleanLogs, pricePerPiece, true);
    }
  };

  const savePriceLocallyAndSync = (newPrice: number) => {
    const rawPrice = Math.floor(newPrice);
    if (isNaN(rawPrice) || rawPrice <= 0 || rawPrice > 100000) return;
    
    setPricePerPiece(rawPrice);
    if (user) {
      localStorage.setItem(`price_per_piece_${user.uid}`, String(rawPrice));
      localStorage.setItem(`needs_sync_${user.uid}`, "true");
      triggerSync(user.uid, logs, rawPrice, true);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        
        // Immediate Local Hydration – zero latency, fully works offline with deep validation
        const localLogs = localStorage.getItem(`delivery_logs_${currentUser.uid}`);
        const localPrice = localStorage.getItem(`price_per_piece_${currentUser.uid}`);
        if (localLogs) {
          setLogs(safeParseDeliveryLogs(localLogs));
        }
        if (localPrice) {
          const p = Number(localPrice);
          if (p > 0 && p <= 100000) {
            setPricePerPiece(p);
            setPriceInput(String(p));
          }
        }
        
        // Let user into the app instantly without waiting for the network database snapshot
        setLoaded(true);
        setAuthLoading(false);

        if (navigator.onLine) {
          set(ref(db, `users/${currentUser.uid}/email`), currentUser.email).catch(() => {});
        }
        
        // Reactive database connection listener (runs non-blocking in background)
        const userRef = ref(db, `users/${currentUser.uid}`);
        const unsubscribeDb = onValue(userRef, (snapshot) => {
          const data = snapshot.val();
          const needsSync = localStorage.getItem(`needs_sync_${currentUser.uid}`) === "true";
          
          // Only pull from Firebase if we do not have pending local modifications
          if (data && !needsSync) {
            if (data.delivery_logs) {
              const validatedLogs = safeParseDeliveryLogs(data.delivery_logs);
              setLogs(validatedLogs);
              localStorage.setItem(`delivery_logs_${currentUser.uid}`, JSON.stringify(validatedLogs));
            } else {
              setLogs({});
              localStorage.removeItem(`delivery_logs_${currentUser.uid}`);
            }
            if (data.price_per_piece) {
              const p = Math.floor(Number(data.price_per_piece));
              if (p > 0 && p <= 100000) {
                setPricePerPiece(p);
                setPriceInput(String(p));
                localStorage.setItem(`price_per_piece_${currentUser.uid}`, String(p));
              }
            }
          }
          setLoaded(true);
          setAuthLoading(false);
        }, () => {
          setLoaded(true);
          setAuthLoading(false);
        });

        return () => {
          unsubscribeDb();
        };
      } else {
        setUser(null);
        setLogs({});
        setLoaded(false);
        setAuthLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Background Auto-Sync Effect for instant offline reconciliation
  useEffect(() => {
    if (!user) return;
    const needsSync = localStorage.getItem(`needs_sync_${user.uid}`) === "true";
    if (needsSync && isOnline) {
      triggerSync(user.uid, logs, pricePerPiece);
    }
  }, [user, isOnline]);

  const handleAuth = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError("");

    // Trim inputs to secure against whitespace injection and accidental spaces
    const cleanEmail = email.trim();
    const cleanPassword = password;

    if (!cleanEmail) {
      setAuthError("অনুগ্রহ করে একটি সঠিক ইমেল অ্যাড্রেস লিখুন!");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      setAuthError("অনুগ্রহ করে একটি সলিড ইমেল ফরম্যাট ব্যবহার করুন! (যেমন: list@example.com)");
      return;
    }

    if (!cleanPassword) {
      setAuthError("অনুগ্রহ করে পাসওয়ার্ডটি টাইপ করুন!");
      return;
    }

    if (!isLogin && cleanPassword.length < 6) {
      setAuthError("নিরাপত্তার স্বার্থে পাসওয়ার্ডটি কমপক্ষে ৬ অক্ষরের হতে হবে!");
      return;
    }

    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, cleanEmail, cleanPassword);
      } else {
        await createUserWithEmailAndPassword(auth, cleanEmail, cleanPassword);
      }
    } catch (error: any) {
      console.error("Authentication Error:", error);
      const errCode = error?.code;
      if (errCode === "auth/invalid-credential" || errCode === "auth/wrong-password" || errCode === "auth/user-not-found") {
        setAuthError("ইমেল অথবা পাসওয়ার্ডটি ভুল হয়েছে!");
      } else if (errCode === "auth/email-already-in-use") {
        setAuthError("এই ইমেলটি ইতিমধ্যে অন্য একটি অ্যাকাউন্টে ব্যবহার করা হয়েছে!");
      } else if (errCode === "auth/invalid-email") {
        setAuthError("ভুল ইমেল অ্যাড্রেস!");
      } else if (errCode === "auth/weak-password") {
        setAuthError("পাসওয়ার্ডটি অত্যন্ত দুর্বল! অনুগ্রহ করে কমপক্ষে ৬ অক্ষরের শক্তিশালী পাসওয়ার্ড দিন।");
      } else if (error?.code === "auth/network-request-failed" || !navigator.onLine) {
        setAuthError("ইন্টারনেট কানেকশন নেই! অনুগ্রহ করে ইন্টারনেট চালু করুন।");
      } else {
        setAuthError("অনাকাঙ্ক্ষিত ত্রুটি ঘটেছে! অনুগ্রহ করে আবার চেষ্টা করুন।");
      }
    }
  };

  const today = todayKey();
  const todayLog = logs[today] || { count: 0, pricePerPiece };
  const todayEarnings = getEarnings(todayLog);

  const addDelivery = () => {
    // Prevent double triggers within 150ms for smooth single click handling
    const now = Date.now();
    if (now - lastClickTimeRef.current < 150) {
      return;
    }
    lastClickTimeRef.current = now;

    try {
      if ("vibrate" in navigator) {
        navigator.vibrate(35);
      }
    } catch {}

    const existing = logs[today] || { count: 0, pricePerPiece: pricePerPiece, earnings: 0, entries: [] };
    const oldEntries = existing.entries ? [...existing.entries] : [];

    // Migrate potential legacy data structures
    if (oldEntries.length === 0 && existing.count > 0) {
      const parentPrice = (existing.pricePerPiece && existing.pricePerPiece > 0)
        ? existing.pricePerPiece
        : (existing.earnings && existing.earnings > 0)
          ? existing.earnings / existing.count
          : pricePerPiece;
      oldEntries.push({ count: existing.count, pricePerPiece: parentPrice });
    }

    const currentPrice = pricePerPiece;
    const newEntries = [...oldEntries];
    const samePriceIdx = newEntries.findIndex((e) => e.pricePerPiece === currentPrice);
    if (samePriceIdx > -1) {
      newEntries[samePriceIdx] = {
        ...newEntries[samePriceIdx],
        count: newEntries[samePriceIdx].count + 1,
      };
    } else {
      newEntries.push({ count: 1, pricePerPiece: currentPrice });
    }

    const newCount = (existing.count || 0) + 1;
    const newEarnings = newEntries.reduce((sum, e) => sum + e.count * (e.pricePerPiece || 0), 0);

    const updatedLogs = {
      ...logs,
      [today]: {
        count: newCount,
        pricePerPiece: currentPrice,
        earnings: newEarnings,
        entries: newEntries,
      },
    };
    saveLogsLocallyAndSync(updatedLogs);
  };

  const undoDelivery = () => {
    if (!logs[today] || logs[today].count === 0) return;
    try {
      if ("vibrate" in navigator) {
        navigator.vibrate(35);
      }
    } catch {}

    const existing = logs[today];
    const oldEntries = existing.entries ? [...existing.entries] : [];

    // Migrate potential legacy data structures
    if (oldEntries.length === 0 && existing.count > 0) {
      const parentPrice = (existing.pricePerPiece && existing.pricePerPiece > 0)
        ? existing.pricePerPiece
        : (existing.earnings && existing.earnings > 0)
          ? existing.earnings / existing.count
          : pricePerPiece;
      oldEntries.push({ count: existing.count, pricePerPiece: parentPrice });
    }

    // Decrement from the last entry with count > 0 to undo in reverse chronological order
    for (let i = oldEntries.length - 1; i >= 0; i--) {
      if (oldEntries[i].count > 0) {
        oldEntries[i] = {
          ...oldEntries[i],
          count: oldEntries[i].count - 1,
        };
        break;
      }
    }

    const filteredEntries = oldEntries.filter((e) => e.count > 0);
    const newCount = Math.max(0, existing.count - 1);
    const newEarnings = filteredEntries.reduce((sum, e) => sum + e.count * (e.pricePerPiece || 0), 0);

    const updatedLogs = {
      ...logs,
      [today]: {
        ...existing,
        count: newCount,
        earnings: newEarnings,
        entries: filteredEntries,
        pricePerPiece:
          filteredEntries.length > 0
            ? filteredEntries[filteredEntries.length - 1].pricePerPiece
            : (existing.pricePerPiece || pricePerPiece),
      },
    };
    saveLogsLocallyAndSync(updatedLogs);
  };

  const resetToday = () => {
    const updatedLogs = { ...logs };
    delete updatedLogs[today];
    saveLogsLocallyAndSync(updatedLogs);
  };

  const savePrice = () => {
    // Prevent XSS, negative values, decimals, NaNs or extremely large values
    const p = Math.floor(Number(priceInput));
    if (isNaN(p) || p <= 0) {
      setSaveMsg("ভুল ইনপুট! সঠিক ধনাত্মক সংখ্যা দিন।");
      setTimeout(() => setSaveMsg(""), 3000);
      return;
    }
    if (p > 100000) {
      setSaveMsg("ভুল ইনপুট! সর্বোচ্চ ১,০০,০০০ পর্যন্ত হতে পারে।");
      setTimeout(() => setSaveMsg(""), 3000);
      return;
    }
    savePriceLocallyAndSync(p);
    setSaveMsg("সংরক্ষিত হয়েছে ✓");
    setTimeout(() => setSaveMsg(""), 2000);
  };

  if (authLoading || (user && !loaded)) return <SplashScreen />;

  if (!user) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "linear-gradient(135deg, #0a0f1e 0%, #0d1b2e 50%, #091428 100%)",
          fontFamily: "sans-serif",
          color: "#e2e8f0",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "20px",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "360px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(100,255,218,0.15)",
            borderRadius: "16px",
            padding: "24px",
          }}
        >
          <div style={{ textAlign: "center", fontSize: "40px", marginBottom: "10px" }}>📦</div>
          <div
            style={{
              textAlign: "center",
              fontSize: "20px",
              fontWeight: 700,
              color: "#64ffda",
              marginBottom: "20px",
            }}
          >
            {isLogin ? "লগিন করুন" : "নতুন অ্যাকাউন্ট"}
          </div>
          <form
            onSubmit={handleAuth}
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            <input
              type="email"
              placeholder="ইমেইল"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{
                padding: "12px",
                borderRadius: "8px",
                background: "rgba(0,0,0,0.3)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.1)",
                outline: "none",
              }}
            />
            <input
              type="password"
              placeholder="পাসওয়ার্ড"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              style={{
                padding: "12px",
                borderRadius: "8px",
                background: "rgba(0,0,0,0.3)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.1)",
                outline: "none",
              }}
            />
            {authError && (
              <div style={{ color: "#ef4444", fontSize: "12px", textAlign: "center" }}>
                {authError}
              </div>
            )}
            <button
              type="submit"
              style={{
                background: "#64ffda",
                color: "#0a0f1e",
                border: "none",
                borderRadius: "8px",
                padding: "12px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {isLogin ? "লগিন করুন" : "রেজিস্টার করুন"}
            </button>
          </form>
          <div style={{ textAlign: "center", marginTop: "20px", fontSize: "13px", color: "#94a3b8" }}>
            {isLogin ? "অ্যাকাউন্ট নেই?" : "অ্যাকাউন্ট আছে?"}{" "}
            <span
              onClick={() => setIsLogin(!isLogin)}
              style={{ color: "#64ffda", cursor: "pointer" }}
            >
              {isLogin ? "রেজিস্টার করুন" : "লগিন করুন"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const monthlyYm = today.slice(0, 7);
  let totalCount = 0;
  let totalEarnings = 0;
  const monthlyDays: Array<{ date: string; count: number; pricePerPiece: number; earnings?: number; entries?: Array<{ count: number; pricePerPiece: number }> }> = [];

  (Object.entries(logs) as [string, DeliveryLog][])
    .filter(([d]) => d.startsWith(monthlyYm))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([d, v]) => {
      totalCount += v.count;
      totalEarnings += getEarnings(v);
      monthlyDays.push({ date: d, ...v });
    });

  const historyList = (Object.entries(logs) as [string, DeliveryLog][])
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([d, v]) => ({ date: d, ...v }));

  const navItems = [
    ["home", "🏠 হোম"],
    ["history", "📋 ইতিহাস"],
    ["monthly", "📊 মাসিক"],
    ["settings", "⚙️ সেটিং"],
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0a0f1e 0%, #0d1b2e 50%, #091428 100%)",
        fontFamily: "sans-serif",
        color: "#e2e8f0",
        display: "flex",
        flexDirection: "column",
        maxWidth: "480px",
        margin: "0 auto",
      }}
    >
      <div
        style={{
          padding: "20px 20px 12px",
          background: "rgba(100,255,218,0.04)",
          borderBottom: "1px solid rgba(100,255,218,0.1)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: "13px", color: "#64ffda", letterSpacing: "2px" }}>
            ডেলিভারি ট্র্যাকার
          </div>
          <div style={{ fontSize: "20px", fontWeight: 700, color: "#fff", marginTop: "4px" }}>
            {BANGLA_DAYS[new Date().getDay()]}, {formatDate(today)}
          </div>
        </div>
        
        {/* Subtle Online/Offline Sync Indicator */}
        <div
          style={{
            fontSize: "11px",
            padding: "4px 8px",
            borderRadius: "20px",
            fontWeight: "bold",
            display: "flex",
            alignItems: "center",
            gap: "5px",
            background: !isOnline 
              ? "rgba(239, 68, 68, 0.15)" 
              : syncing 
                ? "rgba(255, 215, 0, 0.15)" 
                : "rgba(100, 255, 218, 0.15)",
            color: !isOnline 
              ? "#ff6b6b" 
              : syncing 
                ? "#ffd700" 
                : "#64ffda",
            border: !isOnline 
              ? "1px solid rgba(239, 68, 68, 0.3)" 
              : syncing 
                ? "1px solid rgba(255, 215, 0, 0.3)" 
                : "1px solid rgba(100, 255, 218, 0.3)",
            whiteSpace: "nowrap",
            transition: "all 0.3s ease",
          }}
        >
          <span style={{ fontSize: "7px", lineHeight: 1 }}>
            {!isOnline ? "🔴" : syncing ? "🟡" : "🟢"}
          </span>
          <span>{!isOnline ? "অফলাইন" : syncing ? "সিঙ্ক হচ্ছে" : "অনলাইন"}</span>
        </div>
      </div>
      <div style={{ display: "flex", background: "rgba(0,0,0,0.3)" }}>
        {navItems.map(([v, l]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              flex: 1,
              padding: "10px",
              border: "none",
              background: "transparent",
              color: view === v ? "#64ffda" : "#718096",
              borderBottom: view === v ? "2px solid #64ffda" : "2px solid transparent",
              fontWeight: view === v ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {l}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, padding: "16px", overflowY: "auto" }}>
        {view === "home" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "20px" }}>
              <div
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid #64ffda22",
                  borderRadius: "14px",
                  padding: "12px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "4px" }}>
                  আজকের ডেলিভারি
                </div>
                <div style={{ fontSize: "20px", fontWeight: 700, color: "#64ffda" }}>
                  {toBanglaNum(todayLog.count)} পিস
                </div>
              </div>
              <div
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid #ffd70022",
                  borderRadius: "14px",
                  padding: "12px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "4px" }}>
                  আজকের আয়
                </div>
                <div style={{ fontSize: "20px", fontWeight: 700, color: "#ffd700" }}>
                  ৳{toBanglaNum(todayEarnings)}
                </div>
              </div>
            </div>

            <div style={{ textAlign: "center", marginBottom: "20px" }}>
              <button
                onTouchStart={() => setIsPressed(true)}
                onTouchEnd={() => setIsPressed(false)}
                onMouseDown={() => setIsPressed(true)}
                onMouseUp={() => setIsPressed(false)}
                onMouseLeave={() => setIsPressed(false)}
                onClick={(e) => {
                  e.preventDefault();
                  addDelivery();
                }}
                style={{
                  width: "180px",
                  height: "180px",
                  borderRadius: "50%",
                  background: isPressed
                    ? "radial-gradient(circle, #64ffda 0%, #38b2a0 60%)"
                    : "radial-gradient(circle, #1a6b5e 0%, #0d4a3e 60%)",
                  border: "3px solid #64ffda",
                  boxShadow: isPressed ? "0 0 40px #64ffda66" : "0 0 30px #64ffda33",
                  cursor: "pointer",
                  fontSize: "50px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto",
                  transform: isPressed ? "scale(0.92)" : "scale(1)",
                  transition: "transform 0.08s cubic-bezier(0.25, 1, 0.5, 1), background 0.1s ease, box-shadow 0.12s ease",
                  touchAction: "none",
                }}
              >
                <span style={{ pointerEvents: "none" }}>📦</span>
                <span style={{ fontSize: "13px", color: "#64ffda", fontWeight: 700, pointerEvents: "none" }}>
                  +১ ডেলিভারি
                </span>
              </button>
            </div>

            <div style={{ display: "flex", gap: "10px", justifyContent: "center", marginBottom: "24px" }}>
              <button
                onClick={undoDelivery}
                disabled={todayLog.count === 0}
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: "10px",
                  color: todayLog.count > 0 ? "#f87171" : "#4a5568",
                  padding: "8px 16px",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                ↩ একটি কমান
              </button>
              <button
                onClick={() => setShowResetConfirm(true)}
                disabled={todayLog.count === 0}
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: "10px",
                  color: todayLog.count > 0 ? "#f87171" : "#4a5568",
                  padding: "8px 16px",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                🗑️ আজকের সব মুছুন
              </button>
            </div>
          </div>
        )}

        {view === "history" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {historyList.length > 0 && (
              <button
                onClick={() => setShowClearAllConfirm(true)}
                style={{
                  background: "rgba(239, 68, 68, 0.12)",
                  border: "1px solid rgba(239, 68, 68, 0.35)",
                  color: "#ff6b6b",
                  padding: "12px",
                  borderRadius: "12px",
                  fontWeight: "bold",
                  fontSize: "14px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  marginBottom: "8px",
                  transition: "all 0.2s ease-in-out",
                }}
              >
                <span>🗑️</span> সব ইতিহাস মুছুন (Clear History)
              </button>
            )}
            {historyList.length === 0 ? (
              <div style={{ textAlign: "center", color: "#718096", padding: "20px" }}>
                কোনো ডেটা নেই
              </div>
            ) : (
              historyList.map((h) => (
                <div
                  key={h.date}
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: "14px",
                    padding: "14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ color: "#fff", fontWeight: "bold" }}>{formatDate(h.date)}</div>
                    <div style={{ color: "#94a3b8", fontSize: "12px", marginTop: "4px" }}>
                      {h.entries && h.entries.length > 0 ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          {h.entries.map((ent, idx) => (
                            <div key={idx}>
                              ৳{toBanglaNum(ent.pricePerPiece)}/পিস ({toBanglaNum(ent.count)} পিস)
                            </div>
                          ))}
                        </div>
                      ) : (
                        `৳${toBanglaNum(h.pricePerPiece)}/পিস`
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: "#ffd700", fontWeight: "bold", fontSize: "18px" }}>
                        ৳{toBanglaNum(getEarnings(h))}
                      </div>
                      <div style={{ color: "#64ffda", fontSize: "12px" }}>
                        {toBanglaNum(h.count)} পিস
                      </div>
                    </div>
                    <div style={{ position: "relative" }}>
                      <button
                        onClick={() => setActiveMenuDate(activeMenuDate === h.date ? null : h.date)}
                        style={{
                          background: "rgba(239, 68, 68, 0.06)",
                          border: "1px solid rgba(239, 68, 68, 0.2)",
                          borderRadius: "10px",
                          width: "36px",
                          height: "36px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          transition: "all 0.2s ease-in-out",
                          padding: 0,
                        }}
                        title="অপশন"
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: "3px", alignItems: "center" }}>
                          <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#ef4444" }} />
                          <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#ef4444" }} />
                          <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#ef4444" }} />
                        </div>
                      </button>

                      {activeMenuDate === h.date && (
                        <>
                          <div
                            onClick={() => setActiveMenuDate(null)}
                            style={{
                              position: "fixed",
                              top: 0,
                              left: 0,
                              right: 0,
                              bottom: 0,
                              background: "transparent",
                              zIndex: 999,
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              right: 0,
                              top: "40px",
                              background: "#0d1b2e",
                              border: "1px solid rgba(255, 255, 255, 0.15)",
                              borderRadius: "10px",
                              boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
                              zIndex: 1000,
                              width: "140px",
                              padding: "6px",
                            }}
                          >
                            <button
                              onClick={() => {
                                setDeleteTargetDate(h.date);
                                setActiveMenuDate(null);
                              }}
                              style={{
                                width: "100%",
                                padding: "8px 10px",
                                background: "rgba(239, 68, 68, 0.1)",
                                border: "1px solid rgba(239, 68, 68, 0.2)",
                                color: "#ff6b6b",
                                textAlign: "left",
                                fontSize: "13px",
                                fontWeight: "bold",
                                cursor: "pointer",
                                borderRadius: "8px",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                transition: "all 0.15s ease",
                              }}
                            >
                              <Trash2 size={14} /> রেকর্ড মুছুন
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {view === "monthly" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "20px" }}>
              <div style={{ background: "rgba(255,255,255,0.04)", padding: "16px", borderRadius: "12px", textAlign: "center" }}>
                <div style={{ color: "#94a3b8", fontSize: "12px" }}>মোট পিস</div>
                <div style={{ color: "#64ffda", fontSize: "20px", fontWeight: "bold" }}>
                  {toBanglaNum(totalCount)}
                </div>
              </div>
              <div style={{ background: "rgba(255,255,255,0.04)", padding: "16px", borderRadius: "12px", textAlign: "center" }}>
                <div style={{ color: "#94a3b8", fontSize: "12px" }}>মোট আয়</div>
                <div style={{ color: "#ffd700", fontSize: "20px", fontWeight: "bold" }}>
                  ৳{toBanglaNum(totalEarnings)}
                </div>
              </div>
            </div>
            {monthlyDays.map((d) => (
              <div
                key={d.date}
                style={{
                  background: "rgba(255,255,255,0.02)",
                  padding: "10px",
                  borderBottom: "1px solid #ffffff11",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ color: "#e2e8f0" }}>
                    {toBanglaNum(new Date(d.date).getDate())} তারিখ
                  </span>
                  {d.entries && d.entries.length > 0 && (
                    <span style={{ fontSize: "10px", color: "#94a3b8", marginTop: "2px" }}>
                      {d.entries.map((ent) => `৳${toBanglaNum(ent.pricePerPiece)} (${toBanglaNum(ent.count)}টি)`).join(", ")}
                    </span>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: "#64ffda", fontWeight: "bold" }}>{toBanglaNum(d.count)} পিস</div>
                  <div style={{ color: "#ffd700", fontSize: "12px", marginTop: "2px" }}>
                    ৳{toBanglaNum(getEarnings(d))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "settings" && (
          <div>
            <div
              style={{
                background: "rgba(255,255,255,0.04)",
                padding: "16px",
                borderRadius: "12px",
                marginBottom: "16px",
              }}
            >
              <div style={{ color: "#64ffda", marginBottom: "10px" }}>💰 প্রতি পিস রেট</div>
              <div style={{ display: "flex", gap: "10px" }}>
                <input
                  type="number"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "10px",
                    borderRadius: "8px",
                    background: "rgba(0,0,0,0.3)",
                    color: "#fff",
                    border: "1px solid #ffffff22",
                    outline: "none",
                  }}
                />
                <button
                  onClick={savePrice}
                  style={{
                    background: "rgba(100,255,218,0.2)",
                    color: "#64ffda",
                    border: "none",
                    borderRadius: "8px",
                    padding: "0 16px",
                    cursor: "pointer",
                  }}
                >
                  সেভ
                </button>
              </div>
              {saveMsg && (
                <div style={{ color: "#64ffda", fontSize: "12px", marginTop: "5px" }}>
                  {saveMsg}
                </div>
              )}
            </div>
            <div style={{ background: "rgba(255,255,255,0.02)", padding: "16px", borderRadius: "12px" }}>
              <div style={{ color: "#94a3b8", fontSize: "12px" }}>লগিন আছেন:</div>
              <div style={{ color: "#fff", fontWeight: "bold", marginBottom: "10px" }}>
                {user.email}
              </div>
              <button
                onClick={() => signOut(auth)}
                style={{
                  background: "rgba(239,68,68,0.2)",
                  color: "#f87171",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: "8px",
                  width: "100%",
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                লগআউট করুন
              </button>
            </div>
          </div>
        )}


      </div>

      {showResetConfirm && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(10, 15, 30, 0.85)",
            backdropFilter: "blur(4px)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "340px",
              background: "#0d1b2e",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: "16px",
              padding: "24px",
              textAlign: "center",
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>⚠️</div>
            <div style={{ color: "#f87171", fontSize: "16px", fontWeight: "bold", marginBottom: "16px" }}>
              ডেলিভারি মুছুন
            </div>
            <div style={{ color: "#e2e8f0", fontSize: "14px", lineHeight: "1.5", marginBottom: "24px" }}>
              আপনি কি আজকের সব ডেলিভারি মুছে ফেলতে চান? এটি আর ফিরিয়ে আনা যাবে না।
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                onClick={() => setShowResetConfirm(false)}
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.08)",
                  color: "#94a3b8",
                  border: "none",
                  borderRadius: "8px",
                  padding: "12px",
                  fontSize: "13px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                না, থাক
              </button>
              <button
                onClick={() => {
                  const updatedLogs = { ...logs };
                  delete updatedLogs[today];
                  saveLogsLocallyAndSync(updatedLogs);
                  setShowResetConfirm(false);
                }}
                style={{
                  flex: 1,
                  background: "#ef4444",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "12px",
                  fontSize: "13px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                হ্যাঁ, মুছুন
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearAllConfirm && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(10, 15, 30, 0.85)",
            backdropFilter: "blur(4px)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "340px",
              background: "#0d1b2e",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: "16px",
              padding: "24px",
              textAlign: "center",
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>⚠️</div>
            <div style={{ color: "#f87171", fontSize: "16px", fontWeight: "bold", marginBottom: "16px" }}>
              সব ইতিহাস মুছুন
            </div>
            <div style={{ color: "#e2e8f0", fontSize: "14px", lineHeight: "1.5", marginBottom: "24px" }}>
              আপনি কি সব দিনের ডেলিভারির ইতিহাস মুছে ফেলতে চান? এটি আর ফিরিয়ে আনা যাবে না।
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                onClick={() => setShowClearAllConfirm(false)}
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.08)",
                  color: "#94a3b8",
                  border: "none",
                  borderRadius: "8px",
                  padding: "12px",
                  fontSize: "13px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                না, থাক
              </button>
              <button
                onClick={() => {
                  saveLogsLocallyAndSync({});
                  setShowClearAllConfirm(false);
                }}
                style={{
                  flex: 1,
                  background: "#ef4444",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "12px",
                  fontSize: "13px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                হ্যাঁ, সব মুছুন
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTargetDate && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(10, 15, 30, 0.85)",
            backdropFilter: "blur(4px)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "340px",
              background: "#0d1b2e",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: "16px",
              padding: "24px",
              textAlign: "center",
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>⚠️</div>
            <div style={{ color: "#f87171", fontSize: "16px", fontWeight: "bold", marginBottom: "16px" }}>
              রেকর্ড মুছে ফেলুন
            </div>
            <div style={{ color: "#e2e8f0", fontSize: "14px", lineHeight: "1.5", marginBottom: "24px" }}>
              আপনি কি <strong>{formatDate(deleteTargetDate)}</strong> তারিখের ডেলিভারির রেকর্ড মুছে ফেলতে চান? এটি আর ফিরিয়ে আনা যাবে না।
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                onClick={() => setDeleteTargetDate(null)}
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.08)",
                  color: "#94a3b8",
                  border: "none",
                  borderRadius: "8px",
                  padding: "12px",
                  fontSize: "13px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                না, থাক
              </button>
              <button
                onClick={() => {
                  const updatedLogs = { ...logs };
                  delete updatedLogs[deleteTargetDate];
                  saveLogsLocallyAndSync(updatedLogs);
                  setDeleteTargetDate(null);
                }}
                style={{
                  flex: 1,
                  background: "#ef4444",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "12px",
                  fontSize: "13px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                হ্যাঁ, মুছুন
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

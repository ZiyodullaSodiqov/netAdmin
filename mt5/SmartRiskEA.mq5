//+------------------------------------------------------------------+
//|                                                  SmartRiskEA.mq5 |
//|  Ikki strategiya:                                                |
//|   1) EMA kesishish + trend va RSI filtri                         |
//|   2) Fibonacci: trend bo'yicha 50-61.8% pullback'dan kirish,     |
//|      TP = swing'ning 161.8% kengaytmasi, SL = swing ortida       |
//|  Foizli risk, kunlik limitlar, breakeven/trailing va             |
//|  statistika paneli (win rate, profit factor, expectancy).        |
//+------------------------------------------------------------------+
#property version     "2.10"
#property description "EMA cross + Fibonacci 1.618 EA: % risk, daily limits, stats panel"

#include <Trade/Trade.mqh>

#define FIBO_NAME "SmartRiskEA_Fibo"

enum ENUM_STRATEGY
{
   STRAT_EMA  = 0,   // Faqat EMA kesishish
   STRAT_FIBO = 1,   // Faqat Fibonacci 1.618
   STRAT_BOTH = 2    // Ikkalasi
};

//--- Kirish parametrlari
input group "=== Strategiya ==="
input ENUM_STRATEGY   Strategy      = STRAT_BOTH; // Qaysi strategiya ishlasin
input ENUM_TIMEFRAMES TrendTF       = PERIOD_H4;  // Trend taymfreymi
input int             TrendMA       = 200;        // Trend EMA (TrendTF da)

input group "=== EMA kesishish ==="
input int    FastMA        = 20;      // Tez EMA (joriy taymfreym)
input int    SlowMA        = 50;      // Sekin EMA (joriy taymfreym)
input bool   UseRSIFilter  = true;    // RSI filtrini ishlatish
input int    RSIPeriod     = 14;      // RSI davri
input double RSIBuyMax     = 70;      // BUY faqat RSI shundan past bo'lsa
input double RSISellMin    = 30;      // SELL faqat RSI shundan yuqori bo'lsa
input double ATRMultSL     = 2.0;     // SL = ATR x shu koeffitsient
input double RR            = 2.0;     // TP = SL x RR

input group "=== Fibonacci ==="
input double FiboTarget      = 1.618; // TP: swing'ning kengaytma darajasi
input int    FiboLookback    = 50;    // Swing qidiriladigan shamlar soni
input double MinSwingATR     = 3.0;   // Swing kamida shuncha ATR bo'lsin
input int    MinPullbackBars = 3;     // Swing cho'qqisidan keyin kamida shuncha sham
input double FiboSLBufferATR = 0.5;   // SL swing ortidan shuncha ATR uzoqda
input double FiboMinRR       = 1.5;   // Minimal Risk/Reward
input bool   ShowFibo        = true;  // Grafikda Fibonacci chizish

input group "=== Risk ==="
input double RiskPercent      = 1.0;  // Har savdoda risk (balansdan %)
input int    ATRPeriod        = 14;   // ATR davri
input double MaxDailyLossPct  = 3.0;  // Kunlik maksimal zarar (%)
input int    MaxTradesPerDay  = 5;    // Kuniga maksimal savdolar soni
input double MaxSpreadATRPct  = 15.0; // Maksimal spread (ATR ning %), har qanday simvolga mos

input group "=== Pozitsiya boshqaruvi ==="
input bool   UseBreakeven     = true;  // Breakeven (SL -> kirish narxi)
input double BreakevenAtR     = 1.0;   // Foyda shuncha R bo'lganda breakeven/trailing yoqiladi
input bool   UseTrailing      = false; // Trailing stop (1-testda foydalarni erta kesgan)
input double TrailATRMult     = 2.0;   // Trailing masofasi = ATR x shu

input group "=== Savdo vaqti (server vaqti) ==="
input int    StartHour        = 8;     // Boshlanish soati
input int    EndHour          = 20;    // Tugash soati

input group "=== Umumiy ==="
input long   Magic            = 20261012; // Robot ID (magic number)
input bool   ShowPanel        = true;     // Grafikda statistika paneli

//--- Global o'zgaruvchilar
struct Stats
{
   int    trades;
   int    wins;
   int    losses;
   double grossWin;
   double grossLoss;
   double net;
};

struct TradeSignal
{
   int    dir;     // 1 = BUY, -1 = SELL, 0 = yo'q
   double sl;
   double tp;
   string tag;
};

CTrade   trade;
int      hFast = INVALID_HANDLE, hSlow = INVALID_HANDLE, hTrend = INVALID_HANDLE;
int      hRSI  = INVALID_HANDLE, hATR  = INVALID_HANDLE;
Stats    allStats, dayStats;
int      dayTradesOpened = 0;
double   dayStartBalance = 0;
string   g_status        = "Ishga tushdi";
bool     g_blocked       = true;
datetime g_lastFiboSwing = 0;     // Bir swing bo'yicha faqat bitta savdo

//+------------------------------------------------------------------+
int OnInit()
{
   if(FastMA >= SlowMA)
   {
      Print("Xato: FastMA SlowMA dan kichik bo'lishi kerak");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(RiskPercent <= 0 || RiskPercent > 5)
   {
      Print("Xato: RiskPercent 0 dan katta va 5 dan kichik bo'lishi kerak");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(FiboTarget <= 1.0 || FiboLookback < 10 || MinPullbackBars < 2)
   {
      Print("Xato: Fibonacci parametrlari noto'g'ri");
      return INIT_PARAMETERS_INCORRECT;
   }

   hFast  = iMA(_Symbol, _Period, FastMA, 0, MODE_EMA, PRICE_CLOSE);
   hSlow  = iMA(_Symbol, _Period, SlowMA, 0, MODE_EMA, PRICE_CLOSE);
   hTrend = iMA(_Symbol, TrendTF, TrendMA, 0, MODE_EMA, PRICE_CLOSE);
   hRSI   = iRSI(_Symbol, _Period, RSIPeriod, PRICE_CLOSE);
   hATR   = iATR(_Symbol, _Period, ATRPeriod);
   if(hFast == INVALID_HANDLE || hSlow == INVALID_HANDLE || hTrend == INVALID_HANDLE ||
      hRSI == INVALID_HANDLE || hATR == INVALID_HANDLE)
   {
      Print("Xato: indikatorlarni yaratib bo'lmadi");
      return INIT_FAILED;
   }

   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(50);
   trade.SetTypeFillingBySymbol(_Symbol);

   UpdateStats();
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(hFast);
   IndicatorRelease(hSlow);
   IndicatorRelease(hTrend);
   IndicatorRelease(hRSI);
   IndicatorRelease(hATR);
   ObjectDelete(0, FIBO_NAME);
   Comment("");
}

//+------------------------------------------------------------------+
void OnTick()
{
   ManagePositions();          // Breakeven va trailing har tikda

   bool newBar = IsNewBar();
   if(newBar) UpdateStats();

   // Holat har tikda tekshiriladi, panel darhol yangilanadi
   string reason;
   bool   allowed = CanTrade(reason);
   if(!allowed)
   {
      g_status = reason;
   }
   else if(newBar)             // Tahlil faqat yangi sham ochilganda
   {
      TradeSignal sig;
      if(GetSignal(sig)) OpenTrade(sig);
      else               g_status = "Signal kutilmoqda";
   }
   else if(g_blocked)
   {
      g_status = "Signal kutilmoqda";
   }
   g_blocked = !allowed;

   if(ShowPanel) DrawPanel();
}

//+------------------------------------------------------------------+
void OnTrade()
{
   UpdateStats();
}

//+------------------------------------------------------------------+
//| Yordamchi funksiyalar                                            |
//+------------------------------------------------------------------+
bool IsNewBar()
{
   static datetime last = 0;
   datetime t = iTime(_Symbol, _Period, 0);
   if(t != last) { last = t; return true; }
   return false;
}

bool GetBuf(int handle, int buffer, int shift, int count, double &arr[])
{
   ArraySetAsSeries(arr, true);
   return CopyBuffer(handle, buffer, shift, count, arr) == count;
}

double Norm(double price)
{
   double tick = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tick > 0) price = MathRound(price / tick) * tick;
   return NormalizeDouble(price, _Digits);
}

string StrategyName()
{
   switch(Strategy)
   {
      case STRAT_EMA:  return "EMA kesishish";
      case STRAT_FIBO: return "Fibonacci 1.618";
      default:         return "EMA + Fibonacci";
   }
}

// i-pozitsiyani tanlaydi; shu robotniki bo'lsa true
bool SelectOurPosition(int index)
{
   ulong ticket = PositionGetTicket(index);
   if(ticket == 0) return false;
   return PositionGetString(POSITION_SYMBOL) == _Symbol &&
          PositionGetInteger(POSITION_MAGIC) == Magic;
}

bool HasPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(SelectOurPosition(i)) return true;
   return false;
}

double FloatingPL()
{
   double sum = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(SelectOurPosition(i))
         sum += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
   return sum;
}

//+------------------------------------------------------------------+
//| Statistika: savdolar tarixidan hisoblanadi                       |
//+------------------------------------------------------------------+
void CalcStats(datetime from, Stats &s, int &opened)
{
   ZeroMemory(s);
   opened = 0;
   if(!HistorySelect(from, TimeCurrent() + 60)) return;

   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong t = HistoryDealGetTicket(i);
      if(t == 0) continue;
      if(HistoryDealGetInteger(t, DEAL_MAGIC) != Magic) continue;
      if(HistoryDealGetString(t, DEAL_SYMBOL) != _Symbol) continue;

      long   entry = HistoryDealGetInteger(t, DEAL_ENTRY);
      double pl    = HistoryDealGetDouble(t, DEAL_PROFIT) +
                     HistoryDealGetDouble(t, DEAL_SWAP) +
                     HistoryDealGetDouble(t, DEAL_COMMISSION);

      if(entry == DEAL_ENTRY_IN)
      {
         opened++;
         s.net += pl;              // kirishdagi komissiya
         continue;
      }
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;

      s.trades++;
      s.net += pl;
      if(pl > 0) { s.wins++;   s.grossWin  += pl; }
      else       { s.losses++; s.grossLoss += -pl; }
   }
}

void UpdateStats()
{
   int dummy;
   CalcStats(0, allStats, dummy);
   CalcStats(iTime(_Symbol, PERIOD_D1, 0), dayStats, dayTradesOpened);
   dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE) - dayStats.net;
   if(ShowPanel) DrawPanel();
}

//+------------------------------------------------------------------+
//| Savdo qilish mumkinmi (filtrlar va risk limitlari)               |
//+------------------------------------------------------------------+
bool CanTrade(string &reason)
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
   { reason = "Algo Trading o'chiq"; return false; }

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   bool inSession = (StartHour < EndHour)
                    ? (dt.hour >= StartHour && dt.hour < EndHour)
                    : (dt.hour >= StartHour || dt.hour < EndHour);   // tunni kesib o'tadigan sessiya
   if(!inSession)
   { reason = "Savdo vaqti emas"; return false; }

   // Spread ATR ga nisbatan o'lchanadi: EURUSD va Gold uchun bir xil ishlaydi
   double atr[];
   double spread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(GetBuf(hATR, 0, 1, 1, atr) && atr[0] > 0 && spread > atr[0] * MaxSpreadATRPct / 100.0)
   { reason = "Spread juda katta"; return false; }

   if(dayTradesOpened >= MaxTradesPerDay)
   { reason = "Kunlik savdo limiti tugadi"; return false; }

   double dayPL = dayStats.net + FloatingPL();
   if(dayStartBalance > 0 && dayPL <= -dayStartBalance * MaxDailyLossPct / 100.0)
   { reason = "Kunlik zarar limiti! Ertaga davom etadi"; return false; }

   if(HasPosition())
   { reason = "Pozitsiya ochiq"; return false; }

   reason = "";
   return true;
}

//+------------------------------------------------------------------+
//| Bozor tahlili                                                    |
//+------------------------------------------------------------------+
// Katta trend: 1 = yuqoriga, -1 = pastga, 0 = ma'lumot yo'q
int TrendDirection()
{
   double tr[];
   if(!GetBuf(hTrend, 0, 1, 1, tr)) return 0;
   return iClose(_Symbol, _Period, 1) > tr[0] ? 1 : -1;
}

bool GetSignal(TradeSignal &sig)
{
   sig.dir = 0;
   int trend = TrendDirection();
   if(trend == 0) return false;

   double atr[];
   if(!GetBuf(hATR, 0, 1, 1, atr)) return false;

   // Fibonacci birinchi tekshiriladi: uning SL/TP darajalari aniqroq
   if(Strategy != STRAT_EMA && GetFiboSignal(trend, atr[0], sig)) return true;
   if(Strategy != STRAT_FIBO && GetEmaSignal(trend, atr[0], sig)) return true;
   return false;
}

//--- 1-strategiya: EMA kesishish
bool GetEmaSignal(int trend, double atr, TradeSignal &sig)
{
   double f[], s[], r[];
   if(!GetBuf(hFast, 0, 1, 2, f) || !GetBuf(hSlow, 0, 1, 2, s)) return false;

   // f[0] = oxirgi yopilgan sham, f[1] = undan oldingisi
   bool crossUp   = f[1] <= s[1] && f[0] > s[0];
   bool crossDown = f[1] >= s[1] && f[0] < s[0];

   double rsi = 50;
   if(UseRSIFilter)
   {
      if(!GetBuf(hRSI, 0, 1, 1, r)) return false;
      rsi = r[0];
   }

   double slDist = atr * ATRMultSL;
   if(crossUp && trend > 0 && rsi < RSIBuyMax)
   {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      sig.dir = 1;  sig.sl = ask - slDist;  sig.tp = ask + slDist * RR;  sig.tag = "EMA BUY";
      return true;
   }
   if(crossDown && trend < 0 && rsi > RSISellMin)
   {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      sig.dir = -1; sig.sl = bid + slDist;  sig.tp = bid - slDist * RR;  sig.tag = "EMA SELL";
      return true;
   }
   return false;
}

//--- 2-strategiya: Fibonacci pullback + 1.618 kengaytma
// Trend yuqoriga: oxirgi FiboLookback shamdagi eng past nuqta (L) eng yuqori
// nuqtadan (H) oldin bo'lishi kerak, ya'ni L -> H harakati. Narx 50-61.8%
// zonasiga qaytib, ko'tariluvchi sham bilan yopilsa BUY.
// SL = L dan pastda, TP = L + 1.618 x (H - L). Pastga trend uchun teskarisi.
bool GetFiboSignal(int trend, double atr, TradeSignal &sig)
{
   int hIdx = iHighest(_Symbol, _Period, MODE_HIGH, FiboLookback, 1);
   int lIdx = iLowest(_Symbol, _Period, MODE_LOW, FiboLookback, 1);
   if(hIdx < 0 || lIdx < 0) return false;

   double H = iHigh(_Symbol, _Period, hIdx);
   double L = iLow(_Symbol, _Period, lIdx);
   double R = H - L;
   if(R < atr * MinSwingATR) return false;          // Swing juda kichik

   double o1 = iOpen(_Symbol, _Period, 1);
   double c1 = iClose(_Symbol, _Period, 1);

   if(trend > 0)
   {
      if(lIdx <= hIdx || hIdx < MinPullbackBars) return false;   // L -> H va pullback bo'lishi kerak
      datetime tL = iTime(_Symbol, _Period, lIdx), tH = iTime(_Symbol, _Period, hIdx);
      if(ShowFibo) DrawFibo(tL, L, tH, H);
      if(tH == g_lastFiboSwing) return false;                      // Bu swing ishlatilgan

      double lvl50  = H - 0.500 * R;
      double lvl618 = H - 0.618 * R;
      double lvl786 = H - 0.786 * R;

      // H dan keyingi pullback 78.6% dan chuqur bo'lmasligi kerak
      int mIdx = iLowest(_Symbol, _Period, MODE_LOW, hIdx - 1, 1);
      if(mIdx < 0 || iLow(_Symbol, _Period, mIdx) < lvl786) return false;

      bool touched = iLow(_Symbol, _Period, 1) <= lvl50;     // 50-78.6% zonaga tegdi
      bool bullish = c1 > o1 && c1 > lvl618 && c1 < H;        // zonadan qaytib yopildi
      if(!touched || !bullish) return false;

      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      sig.sl  = L - atr * FiboSLBufferATR;
      sig.tp  = L + FiboTarget * R;
      if(ask <= sig.sl || ask >= sig.tp) return false;
      if((sig.tp - ask) / (ask - sig.sl) < FiboMinRR) return false;
      sig.dir = 1;
      sig.tag = "FIBO BUY";
      g_lastFiboSwing = tH;
      return true;
   }
   else
   {
      if(hIdx <= lIdx || lIdx < MinPullbackBars) return false;   // H -> L va pullback bo'lishi kerak
      datetime tL = iTime(_Symbol, _Period, lIdx), tH = iTime(_Symbol, _Period, hIdx);
      if(ShowFibo) DrawFibo(tH, H, tL, L);
      if(tL == g_lastFiboSwing) return false;

      double lvl50  = L + 0.500 * R;
      double lvl618 = L + 0.618 * R;
      double lvl786 = L + 0.786 * R;

      int mIdx = iHighest(_Symbol, _Period, MODE_HIGH, lIdx - 1, 1);
      if(mIdx < 0 || iHigh(_Symbol, _Period, mIdx) > lvl786) return false;

      bool touched = iHigh(_Symbol, _Period, 1) >= lvl50;
      bool bearish = c1 < o1 && c1 < lvl618 && c1 > L;
      if(!touched || !bearish) return false;

      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      sig.sl  = H + atr * FiboSLBufferATR;
      sig.tp  = H - FiboTarget * R;
      if(bid >= sig.sl || bid <= sig.tp) return false;
      if((bid - sig.tp) / (sig.sl - bid) < FiboMinRR) return false;
      sig.dir = -1;
      sig.tag = "FIBO SELL";
      g_lastFiboSwing = tL;
      return true;
   }
}

// Swing'ni grafikda chizish: 1-nuqta swing boshi, 2-nuqta swing oxiri.
// Level 0 = swing oxiri, 1 = swing boshi, -0.618 = 161.8% kengaytma (TP).
void DrawFibo(datetime t1, double p1, datetime t2, double p2)
{
   if(ObjectFind(0, FIBO_NAME) < 0)
   {
      if(!ObjectCreate(0, FIBO_NAME, OBJ_FIBO, 0, t1, p1, t2, p2)) return;

      double levels[7] = {0.0, 0.382, 0.5, 0.618, 0.786, 1.0, 0.0};
      string texts[7]  = {"0", "38.2", "50.0", "61.8", "78.6", "100", ""};
      levels[6] = 1.0 - FiboTarget;
      texts[6]  = StringFormat("%.1f TP", FiboTarget * 100);
      int n = 7;
      ObjectSetInteger(0, FIBO_NAME, OBJPROP_LEVELS, n);
      for(int i = 0; i < n; i++)
      {
         ObjectSetDouble(0, FIBO_NAME, OBJPROP_LEVELVALUE, i, levels[i]);
         ObjectSetString(0, FIBO_NAME, OBJPROP_LEVELTEXT, i, texts[i] + "  %$");
         ObjectSetInteger(0, FIBO_NAME, OBJPROP_LEVELCOLOR, i, clrGold);
      }
      ObjectSetInteger(0, FIBO_NAME, OBJPROP_RAY_RIGHT, true);
   }
   else
   {
      ObjectMove(0, FIBO_NAME, 0, t1, p1);
      ObjectMove(0, FIBO_NAME, 1, t2, p2);
   }
   ChartRedraw();
}

//+------------------------------------------------------------------+
//| Risk hisoblash: SL masofasiga qarab lot hajmi                    |
//+------------------------------------------------------------------+
double CalcLot(double slDist, ENUM_ORDER_TYPE type, double price)
{
   double riskMoney = AccountInfoDouble(ACCOUNT_BALANCE) * RiskPercent / 100.0;
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue <= 0 || tickSize <= 0 || slDist <= 0) return 0;

   double lossPerLot = slDist / tickSize * tickValue;
   double lot = riskMoney / lossPerLot;

   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   lot = MathFloor(lot / step) * step;

   if(lot < minL)
   {
      PrintFormat("Savdo o'tkazib yuborildi: hisoblangan lot %.4f < minimal %.2f (risk %.2f, SL masofasi %.5f)",
                  lot, minL, riskMoney, slDist);
      return 0;
   }
   lot = MathMin(lot, maxL);

   double margin;
   if(OrderCalcMargin(type, _Symbol, lot, price, margin) &&
      margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE) * 0.9)
   {
      Print("Savdo o'tkazib yuborildi: marja yetarli emas");
      return 0;
   }
   return NormalizeDouble(lot, 2);
}

//+------------------------------------------------------------------+
void OpenTrade(TradeSignal &sig)
{
   bool   isBuy   = sig.dir > 0;
   double price   = isBuy ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double slDist  = MathAbs(price - sig.sl);
   double minDist = (double)(SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) +
                             SymbolInfoInteger(_Symbol, SYMBOL_SPREAD)) * _Point;
   if(slDist < minDist)
   {
      g_status = sig.tag + ": SL juda yaqin, o'tkazib yuborildi";
      return;
   }

   double lot = CalcLot(slDist, isBuy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, price);
   if(lot <= 0) { g_status = "Lot juda kichik / marja yetarli emas"; return; }

   bool ok = isBuy
             ? trade.Buy(lot, _Symbol, price, Norm(sig.sl), Norm(sig.tp), sig.tag)
             : trade.Sell(lot, _Symbol, price, Norm(sig.sl), Norm(sig.tp), sig.tag);

   if(ok) g_status = StringFormat("%s ochildi: %.2f lot", sig.tag, lot);
   else   g_status = sig.tag + " xatosi: " + trade.ResultRetcodeDescription();
   Print(g_status);
}

//+------------------------------------------------------------------+
//| Breakeven va trailing stop                                       |
//+------------------------------------------------------------------+
void ManagePositions()
{
   if(!UseBreakeven && !UseTrailing) return;

   double atr[];
   bool   haveATR  = GetBuf(hATR, 0, 1, 1, atr);
   double stopsLvl = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!SelectOurPosition(i)) continue;

      ulong  ticket = (ulong)PositionGetInteger(POSITION_TICKET);
      long   type   = PositionGetInteger(POSITION_TYPE);
      double open   = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl     = PositionGetDouble(POSITION_SL);
      double tp     = PositionGetDouble(POSITION_TP);
      if(sl <= 0) continue;

      if(type == POSITION_TYPE_BUY)
      {
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         // SL hali zarar tomonida bo'lsa, u boshlang'ich risk (1R) hisoblanadi
         if(sl < open && bid - open < (open - sl) * BreakevenAtR) continue;

         double newSL = sl;
         if(UseBreakeven && newSL < open) newSL = open;
         if(UseTrailing && haveATR)
         {
            double t = bid - atr[0] * TrailATRMult;
            if(t > newSL) newSL = t;
         }
         if(newSL > sl + _Point && bid - newSL > stopsLvl)
            trade.PositionModify(ticket, Norm(newSL), tp);
      }
      else
      {
         double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         if(sl > open && open - ask < (sl - open) * BreakevenAtR) continue;

         double newSL = sl;
         if(UseBreakeven && newSL > open) newSL = open;
         if(UseTrailing && haveATR)
         {
            double t = ask + atr[0] * TrailATRMult;
            if(t < newSL) newSL = t;
         }
         if(newSL < sl - _Point && newSL - ask > stopsLvl)
            trade.PositionModify(ticket, Norm(newSL), tp);
      }
   }
}

//+------------------------------------------------------------------+
//| Statistika paneli                                                |
//+------------------------------------------------------------------+
void DrawPanel()
{
   double winRate = allStats.trades > 0 ? 100.0 * allStats.wins / allStats.trades : 0;
   double avgWin  = allStats.wins   > 0 ? allStats.grossWin  / allStats.wins   : 0;
   double avgLoss = allStats.losses > 0 ? allStats.grossLoss / allStats.losses : 0;
   double pf      = allStats.grossLoss > 0 ? allStats.grossWin / allStats.grossLoss : 0;
   double expect  = allStats.trades > 0 ? allStats.net / allStats.trades : 0;
   string cur     = AccountInfoString(ACCOUNT_CURRENCY);

   string txt = StringFormat(
      "=== SmartRiskEA v2 ===\n"
      "Strategiya: %s\n"
      "Holat: %s\n"
      "Risk: %.1f%% / savdo\n"
      "\n--- Umumiy statistika ---\n"
      "Savdolar: %d  (foyda %d / zarar %d)\n"
      "Win rate: %.1f%%\n"
      "O'rtacha foyda: %.2f %s\n"
      "O'rtacha zarar: %.2f %s\n"
      "Profit factor: %.2f\n"
      "Expectancy: %.2f %s / savdo\n"
      "Sof natija: %.2f %s\n"
      "\n--- Bugun ---\n"
      "Ochilgan savdolar: %d / %d\n"
      "Yopilgan P/L: %.2f %s\n"
      "Ochiq P/L: %.2f %s",
      StrategyName(), g_status, RiskPercent,
      allStats.trades, allStats.wins, allStats.losses,
      winRate,
      avgWin, cur,
      avgLoss, cur,
      pf,
      expect, cur,
      allStats.net, cur,
      dayTradesOpened, MaxTradesPerDay,
      dayStats.net, cur,
      FloatingPL(), cur);

   Comment(txt);
}
//+------------------------------------------------------------------+

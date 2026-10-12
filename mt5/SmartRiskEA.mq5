//+------------------------------------------------------------------+
//|                                                  SmartRiskEA.mq5 |
//|  EMA kesishish + trend va RSI filtri, ATR asosida SL,             |
//|  foizli risk, kunlik limitlar, breakeven/trailing va              |
//|  statistika paneli (win rate, profit factor, expectancy).        |
//+------------------------------------------------------------------+
#property version     "1.00"
#property description "EMA cross EA: % risk, daily limits, breakeven/trailing, stats panel"

#include <Trade/Trade.mqh>

//--- Kirish parametrlari
input group "=== Strategiya ==="
input int             FastMA        = 20;         // Tez EMA (joriy taymfreym)
input int             SlowMA        = 50;         // Sekin EMA (joriy taymfreym)
input ENUM_TIMEFRAMES TrendTF       = PERIOD_H4;  // Trend taymfreymi
input int             TrendMA       = 200;        // Trend EMA (TrendTF da)
input bool            UseRSIFilter  = true;       // RSI filtrini ishlatish
input int             RSIPeriod     = 14;         // RSI davri
input double          RSIBuyMax     = 70;         // BUY faqat RSI shundan past bo'lsa
input double          RSISellMin    = 30;         // SELL faqat RSI shundan yuqori bo'lsa

input group "=== Risk ==="
input double RiskPercent      = 1.0;   // Har savdoda risk (balansdan %)
input int    ATRPeriod        = 14;    // ATR davri
input double ATRMultSL        = 2.0;   // SL = ATR x shu koeffitsient
input double RR               = 2.0;   // TP = SL x RR
input double MaxDailyLossPct  = 3.0;   // Kunlik maksimal zarar (%)
input int    MaxTradesPerDay  = 5;     // Kuniga maksimal savdolar soni
input int    MaxSpreadPoints  = 30;    // Maksimal spread (point)

input group "=== Pozitsiya boshqaruvi ==="
input bool   UseBreakeven     = true;  // Breakeven (SL -> kirish narxi)
input double BreakevenAtR     = 1.0;   // Foyda shuncha R bo'lganda breakeven/trailing yoqiladi
input bool   UseTrailing      = true;  // Trailing stop
input double TrailATRMult     = 1.5;   // Trailing masofasi = ATR x shu

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

CTrade trade;
int    hFast = INVALID_HANDLE, hSlow = INVALID_HANDLE, hTrend = INVALID_HANDLE;
int    hRSI  = INVALID_HANDLE, hATR  = INVALID_HANDLE;
Stats  allStats, dayStats;
int    dayTradesOpened = 0;
double dayStartBalance = 0;
string g_status        = "Ishga tushdi";

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
   trade.SetDeviationInPoints(20);
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
   Comment("");
}

//+------------------------------------------------------------------+
void OnTick()
{
   ManagePositions();          // Breakeven va trailing har tikda

   if(!IsNewBar()) return;     // Tahlil faqat yangi sham ochilganda

   UpdateStats();

   string reason;
   if(!CanTrade(reason))
   {
      g_status = reason;
   }
   else
   {
      int sig = GetSignal();
      if(sig != 0) OpenTrade(sig);
      else         g_status = "Signal kutilmoqda";
   }

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

   if(SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) > MaxSpreadPoints)
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
//| Bozor tahlili: 1 = BUY, -1 = SELL, 0 = signal yo'q               |
//+------------------------------------------------------------------+
int GetSignal()
{
   double f[], s[], tr[], r[];
   if(!GetBuf(hFast, 0, 1, 2, f) || !GetBuf(hSlow, 0, 1, 2, s) || !GetBuf(hTrend, 0, 1, 1, tr))
      return 0;

   // f[0] = oxirgi yopilgan sham, f[1] = undan oldingisi
   bool crossUp   = f[1] <= s[1] && f[0] > s[0];
   bool crossDown = f[1] >= s[1] && f[0] < s[0];
   double close1  = iClose(_Symbol, _Period, 1);

   double rsi = 50;
   if(UseRSIFilter)
   {
      if(!GetBuf(hRSI, 0, 1, 1, r)) return 0;
      rsi = r[0];
   }

   // Faqat katta trend yo'nalishida savdo qilamiz
   if(crossUp   && close1 > tr[0] && rsi < RSIBuyMax)  return 1;
   if(crossDown && close1 < tr[0] && rsi > RSISellMin) return -1;
   return 0;
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
void OpenTrade(int sig)
{
   double atr[];
   if(!GetBuf(hATR, 0, 1, 1, atr)) return;

   double slDist  = atr[0] * ATRMultSL;
   double minDist = (double)(SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) +
                             SymbolInfoInteger(_Symbol, SYMBOL_SPREAD)) * _Point;
   if(slDist < minDist) slDist = minDist;

   if(sig > 0)
   {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double lot = CalcLot(slDist, ORDER_TYPE_BUY, ask);
      if(lot <= 0) { g_status = "Lot juda kichik / marja yetarli emas"; return; }
      if(trade.Buy(lot, _Symbol, ask, Norm(ask - slDist), Norm(ask + slDist * RR), "SmartRisk BUY"))
         g_status = StringFormat("BUY ochildi: %.2f lot", lot);
      else
         g_status = "BUY xatosi: " + trade.ResultRetcodeDescription();
   }
   else
   {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double lot = CalcLot(slDist, ORDER_TYPE_SELL, bid);
      if(lot <= 0) { g_status = "Lot juda kichik / marja yetarli emas"; return; }
      if(trade.Sell(lot, _Symbol, bid, Norm(bid + slDist), Norm(bid - slDist * RR), "SmartRisk SELL"))
         g_status = StringFormat("SELL ochildi: %.2f lot", lot);
      else
         g_status = "SELL xatosi: " + trade.ResultRetcodeDescription();
   }
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
      if(tp <= 0) continue;

      double risk = MathAbs(tp - open) / RR;   // boshlang'ich SL masofasi (1R)

      if(type == POSITION_TYPE_BUY)
      {
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         if(bid - open < risk * BreakevenAtR) continue;

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
         if(open - ask < risk * BreakevenAtR) continue;

         double newSL = sl;
         if(UseBreakeven && (newSL == 0 || newSL > open)) newSL = open;
         if(UseTrailing && haveATR)
         {
            double t = ask + atr[0] * TrailATRMult;
            if(newSL == 0 || t < newSL) newSL = t;
         }
         if(newSL > 0 && (sl == 0 || newSL < sl - _Point) && newSL - ask > stopsLvl)
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
      "=== SmartRiskEA ===\n"
      "Holat: %s\n"
      "Risk: %.1f%% / savdo  |  RR 1:%.1f\n"
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
      g_status, RiskPercent, RR,
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

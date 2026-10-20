import { useState } from "react";
import type { PortfolioState, Trade } from "./types";
import { recordTrade, todayIST } from "./transactions";

export default function PurchaseEntry({state,onSave,onClose}:{state:PortfolioState;onSave:(s:PortfolioState)=>void;onClose:()=>void}) {
  const [error,setError]=useState("");
  return <div className="entry-overlay"><section className="panel entry-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-title"><div className="panel-title"><h2 id="purchase-title">Record a purchase</h2><button onClick={onClose} aria-label="Close purchase form">×</button></div><p>Enter an executed Groww purchase, just as in LotBook. Your holdings and analysis update when saved.</p>
    <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget); try {
      const trade:Trade={id:crypto.randomUUID(),symbol:String(f.get("symbol")).trim().toUpperCase().replace(/\.(NS|BO)$/,""),name:String(f.get("name") || f.get("symbol")).trim(),date:String(f.get("date")),side:"BUY",quantity:Number(f.get("quantity")),price:Number(f.get("price")),charges:f.get("charges")===""?undefined:Number(f.get("charges"))};
      onSave(recordTrade(state,trade));onClose();
    }catch(err){setError(err instanceof Error?err.message:"Could not save purchase.");}}}>
      <div className="research-controls"><label>Exact stock symbol<input name="symbol" list="known-symbols" autoFocus required maxLength={40} placeholder="RELIANCE" /></label><datalist id="known-symbols">{state.holdings.map(h=><option key={h.symbol} value={h.symbol}>{h.name}</option>)}</datalist><label>Company name (optional)<input name="name" maxLength={100}/></label><label>Execution date<input name="date" type="date" defaultValue={todayIST()} max={todayIST()} required/></label><label>Shares purchased<input name="quantity" type="number" min="0.000001" step="any" required/></label><label>Executed price per share (₹)<input name="price" type="number" min="0.000001" step="any" required/></label><label>Buy charges (₹, optional)<input name="charges" type="number" min="0" step="any" placeholder="Blank = unknown"/></label></div>
      <p>Average purchase cost excludes charges, matching the holdings display. Charges remain in the trade record for FIFO analysis. No order is sent to Groww.</p>{error&&<p role="alert" className="loss">{error}</p>}<button className="primary">Save purchase</button> <button type="button" className="secondary" onClick={onClose}>Cancel</button>
    </form></section></div>;
}

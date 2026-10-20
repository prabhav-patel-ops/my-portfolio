import {afterEach,expect,it,vi} from "vitest";
import {renderToString} from "react-dom/server";
import App from "../src/App";
import {blankState} from "../src/storage";
import type {Quote} from "../src/types";

afterEach(()=>vi.unstubAllGlobals());
it("renders the screenshot case as 3 checked and 16 retained without calling all quotes recent",()=>{
  const symbols=Array.from({length:19},(_,i)=>`TEST${i}`),at=new Date().toISOString();
  const quote:Quote={price:100,previousClose:95,marketAt:at,fetchedAt:at,ticker:"TEST.NS",source:"test"};
  const state={...blankState(),profile:"Synthetic test",holdings:symbols.map(symbol=>({symbol,name:symbol,quantity:1,averagePrice:80})),quotes:Object.fromEntries(symbols.map(symbol=>[symbol,quote])),quoteRefresh:{attemptedAt:at,refreshedSymbols:symbols.slice(0,3),retainedSymbols:symbols.slice(3),missingSymbols:[]}};
  vi.stubGlobal("localStorage",{getItem:()=>JSON.stringify(state)});
  const html=renderToString(<App/>).replace(/<!--.*?-->/g,"");
  expect(html).toContain("19 of 19 holdings have an available saved price");
  expect(html).toContain("3 checked successfully");expect(html).toContain("16 saved after failed checks");
  expect(html).not.toContain("have a recent market price");
});

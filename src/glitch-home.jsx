import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import './glitch-home.css';
import { blocks, pad, pfSvg, reduced, takeGlitchReturn, watchGlitchSheets } from './glitch-fx.js';

const GP_HTML = "<div class=\"gp\" id=\"gp\" hidden>\n    <div class=\"hit\" id=\"hit\" role=\"button\" aria-label=\"打开\"></div>\n    <div class=\"a cbar\"></div>\n    <div class=\"squash\">\n      <div class=\"a bars\">\n        <i style=\"--x:-135px;--y:12px;--w:215px;--h:14px;--t:0ms;--d:205ms;--j:16px\"><b style=\"--m:108px\"></b></i>\n        <i style=\"--x:-90px;--y:26px;--w:245px;--h:12px;--t:18ms;--d:220ms;--j:-20px\"><b style=\"--m:46px\"></b></i>\n        <i style=\"--x:-205px;--y:-2px;--w:145px;--h:9px;--t:35ms;--d:195ms;--j:12px\"><b style=\"--m:22px\"></b></i>\n        <i style=\"--x:5px;--y:2px;--w:190px;--h:11px;--t:52ms;--d:215ms;--j:-14px\"><b style=\"--m:132px\"></b></i>\n        <i style=\"--x:-225px;--y:36px;--w:160px;--h:8px;--t:70ms;--d:195ms;--j:18px\"><b style=\"--m:64px\"></b></i>\n        <i style=\"--x:80px;--y:40px;--w:155px;--h:10px;--t:90ms;--d:210ms;--j:-12px\"><b style=\"--m:92px\"></b></i>\n        <i style=\"--x:-175px;--y:-22px;--w:110px;--h:7px;--t:110ms;--d:175ms;--j:10px\"></i>\n      </div>\n\n      <div class=\"a bd\"></div>\n      <div class=\"a aura\"></div>\n      <div class=\"a swin\"><div class=\"tb\"></div><div class=\"pn\"></div></div>\n      <div class=\"a prog\" id=\"prog\"><div class=\"tb\"><span class=\"pf\" data-pf=\"program\"></span><span class=\"pf pp\" id=\"progPg\"></span><i class=\"dot\"></i></div><div class=\"rows\" id=\"rows\"></div></div>\n\n      <div class=\"a win\">\n        <div class=\"a shd sb\" style=\"left:-200px;top:68px;width:428px;height:22px\"></div>\n        <div class=\"a shd\" style=\"left:-238px;top:-22px;width:50px;height:110px;background:linear-gradient(#14163a 0,#16183e 55%,#3a1c72 80%,#a22ed4 100%)\"></div>\n        <div class=\"a shd\" style=\"left:186px;top:-30px;width:40px;height:104px\"></div>\n        <div class=\"a shd\" style=\"left:100px;top:-88px;width:118px;height:22px\"></div>\n        <div class=\"a rwin\"><img class=\"a hand\" src=\"../skins/gt-hand.webp\" alt=\"\" style=\"left:-6px;top:20px;width:25px;height:28px\"></div>\n\n        <div class=\"a main\">\n          <div class=\"sl\" style=\"top:0;height:24px;--t:70ms;--j:10px\"><div class=\"chrome\" style=\"top:0\"><div class=\"fr\"></div><div class=\"tb\"><span class=\"lg\"></span><span class=\"t\" data-pf=\"window\" data-pu=\"1.15\"></span><span class=\"bt\"><i></i><i></i></span></div><div class=\"ad\"></div><div class=\"tri\"></div><svg class=\"rm\" viewBox=\"0 0 52 8\"><path d=\"M0 7H7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M8.5 1L12.5 7M13 1L17 7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M20 2.5H51M20 5H47M20 7.4H43\" stroke=\"#b4a2cc\" stroke-width=\".8\"/></svg><div class=\"bb\"></div></div></div>\n          <div class=\"sl\" style=\"top:24px;height:40px;--t:90ms;--j:-14px\"><div class=\"chrome\" style=\"top:-24px\"><div class=\"fr\"></div><div class=\"tb\"><span class=\"lg\"></span><span class=\"t\" data-pf=\"window\" data-pu=\"1.15\"></span><span class=\"bt\"><i></i><i></i></span></div><div class=\"ad\"></div><div class=\"tri\"></div><svg class=\"rm\" viewBox=\"0 0 52 8\"><path d=\"M0 7H7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M8.5 1L12.5 7M13 1L17 7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M20 2.5H51M20 5H47M20 7.4H43\" stroke=\"#b4a2cc\" stroke-width=\".8\"/></svg><div class=\"bb\"></div></div></div>\n          <div class=\"sl\" style=\"top:64px;height:42px;--t:80ms;--j:12px\"><div class=\"chrome\" style=\"top:-64px\"><div class=\"fr\"></div><div class=\"tb\"><span class=\"lg\"></span><span class=\"t\" data-pf=\"window\" data-pu=\"1.15\"></span><span class=\"bt\"><i></i><i></i></span></div><div class=\"ad\"></div><div class=\"tri\"></div><svg class=\"rm\" viewBox=\"0 0 52 8\"><path d=\"M0 7H7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M8.5 1L12.5 7M13 1L17 7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M20 2.5H51M20 5H47M20 7.4H43\" stroke=\"#b4a2cc\" stroke-width=\".8\"/></svg><div class=\"bb\"></div></div></div>\n          <div class=\"sl\" style=\"top:106px;height:36px;--t:100ms;--j:-8px\"><div class=\"chrome\" style=\"top:-106px\"><div class=\"fr\"></div><div class=\"tb\"><span class=\"lg\"></span><span class=\"t\" data-pf=\"window\" data-pu=\"1.15\"></span><span class=\"bt\"><i></i><i></i></span></div><div class=\"ad\"></div><div class=\"tri\"></div><svg class=\"rm\" viewBox=\"0 0 52 8\"><path d=\"M0 7H7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M8.5 1L12.5 7M13 1L17 7\" stroke=\"#e8203c\" stroke-width=\"2\"/><path d=\"M20 2.5H51M20 5H47M20 7.4H43\" stroke=\"#b4a2cc\" stroke-width=\".8\"/></svg><div class=\"bb\"></div></div></div>\n        </div>\n\n        <img class=\"a mon1\" src=\"../skins/gt-mon1.webp\" alt=\"\" style=\"left:-175px;top:-9.6px;width:57px;height:63.6px\"><div class=\"a mscr\" id=\"mscr\" style=\"left:-164.2px;top:10.7px;width:15.2px;height:12.7px\"><b></b></div>\n        <img class=\"a mon2\" src=\"../skins/gt-mon2.webp\" alt=\"\" style=\"left:-44px;top:-4px;width:56px;height:58px\">\n        <img class=\"a mon3\" src=\"../skins/gt-mon3.webp\" alt=\"\" style=\"left:-110px;top:-4px;width:54px;height:58px\">\n        <img class=\"a mb mb1\" src=\"../skins/gt-mon1b.webp\" alt=\"\" style=\"left:-175px;top:-9.6px;width:57px;height:63.6px\">\n        <img class=\"a mb mb2\" src=\"../skins/gt-mon2b.webp\" alt=\"\" style=\"left:-44px;top:-4px;width:56px;height:58px\">\n        <svg class=\"a cry\" viewBox=\"0 0 42 26\" width=\"42\" height=\"26\" style=\"left:-193px;top:-75px\"><polygon points=\"0,14 8,3 24,0 40,6 42,18 30,26 10,25\" fill=\"#c6d2f6\" fill-opacity=\".86\" stroke=\"#6f7fd0\" stroke-width=\"1\"/><polygon points=\"8,3 24,0 18,13\" fill=\"#eef3ff\" fill-opacity=\".9\"/><polygon points=\"24,0 40,6 18,13\" fill=\"#d6e0fb\" fill-opacity=\".85\"/><polygon points=\"40,6 42,18 18,13\" fill=\"#a9b8ee\" fill-opacity=\".85\"/><polygon points=\"42,18 30,26 18,13\" fill=\"#8e9fe2\" fill-opacity=\".85\"/><polygon points=\"30,26 10,25 18,13\" fill=\"#b7c4f2\" fill-opacity=\".85\"/><polygon points=\"10,25 0,14 18,13\" fill=\"#9aaae6\" fill-opacity=\".85\"/><polyline points=\"8,3 18,13 24,0\" fill=\"none\" stroke=\"#fff\" stroke-width=\".7\" opacity=\".8\"/></svg>\n        <img class=\"a warn\" src=\"../skins/gt-warn.webp\" alt=\"\" style=\"left:-208px;top:-40px;width:42px;height:32px\">\n\n        <div class=\"a tags\" style=\"right:-208px;top:-82px\"><div class=\"tag\" style=\"height:13px\"><span class=\"pf\" data-pf=\"tagA\"></span></div><div class=\"tag fm\" style=\"height:13px\"><span class=\"pf\" data-pf=\"tagB\"></span></div></div>\n        <div class=\"a tags lo\" style=\"left:-178px;top:66px\"><div class=\"tag lo\" style=\"height:11px\"><span class=\"pf\" data-pf=\"tagA\"></span></div><div class=\"tag lo fm\" style=\"height:11px\"><span class=\"pf\" data-pf=\"tagB\"></span></div></div>\n        <div class=\"a foot\"><span class=\"pf\" data-pf=\"foot\"></span></div>\n\n        <!-- 封面 -->\n        <div class=\"k-end\">\n          <div class=\"a ttl\" id=\"ttl\"></div>\n          <div class=\"a sub\" id=\"sub\"></div>\n        </div>\n        <!-- 选章 -->\n        <div class=\"k-turn\">\n          <div class=\"a rib\"><svg class=\"rb\" viewBox=\"0 0 186 26\" width=\"186\" height=\"26\"><defs><linearGradient id=\"rbg\" x1=\"0\" x2=\"1\"><stop offset=\"0\" stop-color=\"#3c0516\"/><stop offset=\".52\" stop-color=\"#760a2c\"/><stop offset=\"1\" stop-color=\"#a6123c\"/></linearGradient></defs><path d=\"M8 1H173A12 12 0 0 1 173 25H5L10 21 2 18 9 14 1 10 8 6 3 3Z\" fill=\"none\" stroke=\"#ff5c8c\" stroke-width=\"4.2\" opacity=\".4\"/><path d=\"M8 1H173A12 12 0 0 1 173 25H5L10 21 2 18 9 14 1 10 8 6 3 3Z\" fill=\"url(#rbg)\" stroke=\"#ff769c\" stroke-width=\"1.35\"/></svg><svg class=\"em\" viewBox=\"-3 -2 38 24\" width=\"50\" height=\"32\" style=\"overflow:visible\"><g shape-rendering=\"crispEdges\"><rect x=\"-3\" y=\"-2\" width=\"38\" height=\"24\" rx=\"9\" fill=\"#ff2a50\" opacity=\".28\"/><rect x=\"1\" y=\"1\" width=\"30\" height=\"18\" rx=\"6\" fill=\"#ff2a50\" opacity=\".22\"/><rect x=\"10\" y=\"0\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"0\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"10\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"0\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"6\" width=\"2\" height=\"2\" fill=\"#ff8aa0\"/><rect x=\"10\" y=\"6\" width=\"2\" height=\"2\" fill=\"#ff8aa0\"/><rect x=\"12\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"30\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"2\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"10\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"12\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"22\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"24\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"28\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"0\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"2\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"10\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"12\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"22\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"24\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"28\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"30\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"2\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"10\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"28\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"0\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"8\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"10\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"14\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"16\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"18\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"20\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"30\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"10\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"20\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"26\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"2\" y=\"18\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"28\" y=\"18\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/></g></svg><span class=\"tx\" id=\"ribTx\"></span></div>\n          <div class=\"a card c1\" id=\"c1\" style=\"--t:240ms\" role=\"button\" aria-label=\"下一章\"><span class=\"l\">章节</span><span class=\"n\"><span class=\"o\" id=\"nO\"></span><span class=\"w\" id=\"nW\"></span></span></div>\n          <div class=\"a card c2\" style=\"--t:255ms\"><span class=\"l\">进入</span><span class=\"n\"><i class=\"ic\"><svg viewBox=\"0 0 26 22\" width=\"26\" height=\"22\"><g fill=\"#161616\"><rect x=\"8.6\" y=\"1.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 13 5.8)\"/><rect x=\"2.6\" y=\"11.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 7 15.8)\"/><rect x=\"14.6\" y=\"11.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 19 15.8)\"/></g></svg><i class=\"gm\"><svg viewBox=\"0 0 26 22\" width=\"26\" height=\"22\"><g fill=\"#ff2fd2\"><rect x=\"8.6\" y=\"1.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 13 5.8)\"/><rect x=\"2.6\" y=\"11.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 7 15.8)\"/><rect x=\"14.6\" y=\"11.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 19 15.8)\"/></g></svg></i><i class=\"gc\"><svg viewBox=\"0 0 26 22\" width=\"26\" height=\"22\"><g fill=\"#27e8ff\"><rect x=\"8.6\" y=\"1.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 13 5.8)\"/><rect x=\"2.6\" y=\"11.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 7 15.8)\"/><rect x=\"14.6\" y=\"11.4\" width=\"8.8\" height=\"8.8\" rx=\"2.4\" transform=\"rotate(45 19 15.8)\"/></g></svg></i></i><b class=\"v\">GO<i class=\"d\">!</i></b></span><i class=\"gb1\"></i><i class=\"gb2\"></i><div class=\"a tw cs cs0\" style=\"left:4.5px;top:36.5px;width:15px;height:15px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div><div class=\"a tw cs cs1\" style=\"left:55.0px;top:15.0px;width:18px;height:18px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div><div class=\"a tw cs cs2\" style=\"left:66.5px;top:41.5px;width:15px;height:15px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div><div class=\"a tw cs cs3\" style=\"left:27.0px;top:50.0px;width:14px;height:14px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div><div class=\"a tw cs cs4\" style=\"left:41.5px;top:7.5px;width:17px;height:17px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div><div class=\"a tw cs cs5\" style=\"left:0.0px;top:15.0px;width:14px;height:14px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div><div class=\"a tw cs cs6\" style=\"left:73.5px;top:7.5px;width:13px;height:13px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div><div class=\"a tw cs cs7\" style=\"left:15.5px;top:5.5px;width:13px;height:13px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div></div>\n          <div class=\"a xb\" id=\"xb\" role=\"button\" aria-label=\"回到封面\">×</div>\n          <div class=\"a dsc\" id=\"dsc\"><span id=\"dscTx\"></span></div>\n        </div>\n\n        <img class=\"a\" src=\"../skins/gt-cube2.webp\" alt=\"\" style=\"left:-44.5px;top:13.6px;width:76px;height:54px;z-index:3\">\n\n        <div class=\"a ch\" style=\"z-index:2\">\n          <img class=\"g1 ga\" src=\"../skins/gt-gh-a0.webp\" alt=\"\" style=\"left:-8.1px;top:-8.1px;width:141.2px;height:201.2px\"><img class=\"g2 ga\" src=\"../skins/gt-gh-a1.webp\" alt=\"\" style=\"left:-6.2px;top:-6.2px;width:137.5px;height:197.5px\"><img class=\"g1 gb\" src=\"../skins/gt-gh-b0.webp\" alt=\"\" style=\"left:-8.1px;top:-8.1px;width:152.5px;height:201.2px\"><img class=\"g2 gb\" src=\"../skins/gt-gh-b1.webp\" alt=\"\" style=\"left:-6.2px;top:-6.2px;width:148.8px;height:197.5px\">\n          <div class=\"body a\" style=\"left:0;top:0\">\n            <div class=\"pa a\"><img class=\"stat\" src=\"../skins/gt-pa.webp\" alt=\"\" style=\"width:125.0px;height:185px\"></div>\n            <div class=\"pb a\"><img class=\"stat\" src=\"../skins/gt-pb.webp\" alt=\"\" style=\"width:136.2px;height:185px\"><img class=\"stat pbc\" src=\"../skins/gt-pbc.webp\" alt=\"\" style=\"width:136.2px;height:185px\"></div>\n          </div>\n        </div>\n\n        <svg width=\"0\" height=\"0\" style=\"position:absolute\" aria-hidden=\"true\"><defs>\n<radialGradient id=\"gC\" cx=\"50%\" cy=\"50%\" r=\"50%\"><stop offset=\"0\" stop-color=\"#ffffff\"/><stop offset=\".16\" stop-color=\"#66fcff\"/><stop offset=\".55\" stop-color=\"#1fe0ff\"/><stop offset=\"1\" stop-color=\"#3a6cff\"/></radialGradient>\n<radialGradient id=\"gM\" cx=\"50%\" cy=\"50%\" r=\"50%\"><stop offset=\"0\" stop-color=\"#ffffff\"/><stop offset=\".14\" stop-color=\"#ffb8f4\"/><stop offset=\".32\" stop-color=\"#ff2fd2\"/><stop offset=\".68\" stop-color=\"#d82ad6\"/><stop offset=\"1\" stop-color=\"#5a3cff\"/></radialGradient>\n<symbol id=\"star\" viewBox=\"-12 -12 24 24\"><path d=\"M0-8Q.45-.45 12 0Q.45 .45 0 8Q-.45 .45-12 0Q-.45-.45 0-8Z\"/></symbol>\n<radialGradient id=\"gB\" cx=\"36%\" cy=\"30%\" r=\"72%\"><stop offset=\"0\" stop-color=\"#eef2ff\" stop-opacity=\".82\"/><stop offset=\".48\" stop-color=\"#b4bcef\" stop-opacity=\".7\"/><stop offset=\"1\" stop-color=\"#8b90de\" stop-opacity=\".78\"/></radialGradient>\n</defs></svg>\n<div class=\"a tw tweR0 idle\" style=\"left:162.0px;top:-74.0px;width:50px;height:50px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweR1 idle\" style=\"left:142.0px;top:-72.0px;width:48px;height:48px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweR2 idle\" style=\"left:169.0px;top:-80.0px;width:46px;height:46px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweR3 idle\" style=\"left:216.0px;top:-71.0px;width:38px;height:38px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweL0 idle\" style=\"left:-193.0px;top:-2.0px;width:50px;height:50px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweL1 idle\" style=\"left:-243.0px;top:-2.0px;width:48px;height:48px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweL2 idle\" style=\"left:-201.0px;top:-8.0px;width:46px;height:46px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweL3 idle\" style=\"left:-226.0px;top:14.0px;width:38px;height:38px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweH0 idle\" style=\"left:174.0px;top:3.0px;width:18px;height:18px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweH1 idle\" style=\"left:133.0px;top:4.0px;width:14px;height:14px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tweH2 idle\" style=\"left:147.0px;top:4.0px;width:16px;height:16px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtR0 idle\" style=\"left:162.0px;top:-74.0px;width:50px;height:50px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtR1 idle\" style=\"left:142.0px;top:-72.0px;width:48px;height:48px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtR2 idle\" style=\"left:169.0px;top:-80.0px;width:46px;height:46px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtR3 idle\" style=\"left:216.0px;top:-71.0px;width:38px;height:38px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtL0 idle\" style=\"left:-193.0px;top:-2.0px;width:50px;height:50px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtL1 idle\" style=\"left:-243.0px;top:-2.0px;width:48px;height:48px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtL2 idle\" style=\"left:-201.0px;top:-8.0px;width:46px;height:46px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtL3 idle\" style=\"left:-226.0px;top:14.0px;width:38px;height:38px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtH0 idle\" style=\"left:110.0px;top:21.0px;width:18px;height:18px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtH1 idle\" style=\"left:100.0px;top:14.0px;width:20px;height:20px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtH2 idle\" style=\"left:144.0px;top:13.0px;width:22px;height:22px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw twtH3 idle\" style=\"left:140.0px;top:5.0px;width:14px;height:14px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp0\" style=\"left:67.1px;top:-43.9px;width:30px;height:30px;--t:430ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp1\" style=\"left:113.0px;top:-46.0px;width:28px;height:28px;--t:440ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp2\" style=\"left:51.9px;top:-36.1px;width:26px;height:26px;--t:445ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp3\" style=\"left:130.1px;top:-4.9px;width:30px;height:30px;--t:435ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp4\" style=\"left:148.9px;top:-1.1px;width:26px;height:26px;--t:450ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp5\" style=\"left:164.8px;top:-4.2px;width:24px;height:24px;--t:455ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp6\" style=\"left:65.1px;top:43.1px;width:30px;height:30px;--t:440ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp7\" style=\"left:101.0px;top:31.0px;width:28px;height:28px;--t:450ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp8\" style=\"left:37.8px;top:49.8px;width:24px;height:24px;--t:460ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp9\" style=\"left:20.9px;top:11.9px;width:26px;height:26px;--t:445ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw tsp tsp10\" style=\"left:89.8px;top:-15.2px;width:24px;height:24px;--t:465ms\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a gh gh-e\" style=\"left:13.5px;top:-86.30000000000001px\"><div class=\"gf\"><svg viewBox=\"-30 -20 60 58\" width=\"72\" height=\"69.6\" style=\"position:absolute;left:-36px;top:-24px;overflow:visible\"><g class=\"gt\"><path d=\"M-3 14C-4 22-6 28-12 31C-16 33-18 30-16 28\" fill=\"none\" stroke=\"#8d8be0\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></g><g class=\"gw gl\"><path class=\"w1\" d=\"M-14 4C-18-1-25-2-31 1C-27 3-27 5-28 9C-25 6-22 7-21 10C-19 7-17 7-15 8Z\"/><path class=\"w2\" d=\"M-14 6C-19 4-25 5-31 9C-26 10-25 11-25 14C-22 11-20 12-18 14C-18 11-16 10-14 10Z\"/><path class=\"w3\" d=\"M-14 7C-18 9-23 12-28 18C-23 16-22 17-21 20C-19 16-17 16-15 17C-16 13-15 11-13 10Z\"/></g><g class=\"gw gr\"><path class=\"w1\" d=\"M14 8C18 3 25 2 31 5C27 7 27 9 28 13C25 10 22 11 21 14C19 11 17 11 15 12Z\"/><path class=\"w2\" d=\"M14 10C19 8 25 9 31 13C26 14 25 15 25 18C22 15 20 16 18 18C18 15 16 14 14 14Z\"/><path class=\"w3\" d=\"M14 11C18 13 23 16 28 22C23 20 22 21 21 24C19 20 17 20 15 21C16 17 15 15 13 14Z\"/></g><circle r=\"14.6\" fill=\"url(#gB)\" stroke=\"#f6f4ff\" stroke-width=\"1.8\"/><path d=\"M12.2 7.6A14.6 14.6 0 0 1 2.4 14.4\" fill=\"none\" stroke=\"#f9b5f2\" stroke-width=\"2.2\" stroke-linecap=\"round\"/><path d=\"M-9.8-7.8A12 12 0 0 1-2.6-11.8\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.8\" stroke-linecap=\"round\" opacity=\".95\"/><circle cx=\"-7.2\" cy=\"-5.2\" r=\"1.1\" fill=\"#fff\" opacity=\".75\"/><ellipse cx=\"-5.2\" cy=\"-2.6\" rx=\"2.1\" ry=\"2.45\" fill=\"#2e315e\"/><circle cx=\"-5.7\" cy=\"-3.4\" r=\".95\" fill=\"#fff\"/><ellipse cx=\"2.8\" cy=\"-3.2\" rx=\"2.1\" ry=\"2.45\" fill=\"#2e315e\"/><circle cx=\"2.3\" cy=\"-4\" r=\".95\" fill=\"#fff\"/><path d=\"M1.4 2.2C3.1 1.6 4.0 3.3 2.3 4.1C4.2 4.5 3.6 6.8 1.5 6.3\" fill=\"none\" stroke=\"#343769\" stroke-width=\"1.05\" stroke-linecap=\"round\"/></svg></div></div><div class=\"a gh gh-t\" style=\"left:5.5px;top:-84.4px\"><div class=\"gf\"><svg viewBox=\"-30 -20 60 58\" width=\"72\" height=\"69.6\" style=\"position:absolute;left:-36px;top:-24px;overflow:visible\"><g class=\"gt\"><path d=\"M-3 14C-4 22-6 28-12 31C-16 33-18 30-16 28\" fill=\"none\" stroke=\"#8d8be0\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></g><g class=\"gw gl\"><path class=\"w1\" d=\"M-14 4C-18-1-25-2-31 1C-27 3-27 5-28 9C-25 6-22 7-21 10C-19 7-17 7-15 8Z\"/><path class=\"w2\" d=\"M-14 6C-19 4-25 5-31 9C-26 10-25 11-25 14C-22 11-20 12-18 14C-18 11-16 10-14 10Z\"/><path class=\"w3\" d=\"M-14 7C-18 9-23 12-28 18C-23 16-22 17-21 20C-19 16-17 16-15 17C-16 13-15 11-13 10Z\"/></g><g class=\"gw gr\"><path class=\"w1\" d=\"M14 8C18 3 25 2 31 5C27 7 27 9 28 13C25 10 22 11 21 14C19 11 17 11 15 12Z\"/><path class=\"w2\" d=\"M14 10C19 8 25 9 31 13C26 14 25 15 25 18C22 15 20 16 18 18C18 15 16 14 14 14Z\"/><path class=\"w3\" d=\"M14 11C18 13 23 16 28 22C23 20 22 21 21 24C19 20 17 20 15 21C16 17 15 15 13 14Z\"/></g><circle r=\"14.6\" fill=\"url(#gB)\" stroke=\"#f6f4ff\" stroke-width=\"1.8\"/><path d=\"M12.2 7.6A14.6 14.6 0 0 1 2.4 14.4\" fill=\"none\" stroke=\"#f9b5f2\" stroke-width=\"2.2\" stroke-linecap=\"round\"/><path d=\"M-9.8-7.8A12 12 0 0 1-2.6-11.8\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.8\" stroke-linecap=\"round\" opacity=\".95\"/><circle cx=\"-7.2\" cy=\"-5.2\" r=\"1.1\" fill=\"#fff\" opacity=\".75\"/><ellipse cx=\"-5.2\" cy=\"-2.6\" rx=\"2.1\" ry=\"2.45\" fill=\"#2e315e\"/><circle cx=\"-5.7\" cy=\"-3.4\" r=\".95\" fill=\"#fff\"/><ellipse cx=\"2.8\" cy=\"-3.2\" rx=\"2.1\" ry=\"2.45\" fill=\"#2e315e\"/><circle cx=\"2.3\" cy=\"-4\" r=\".95\" fill=\"#fff\"/><path d=\"M1.4 2.2C3.1 1.6 4.0 3.3 2.3 4.1C4.2 4.5 3.6 6.8 1.5 6.3\" fill=\"none\" stroke=\"#343769\" stroke-width=\"1.05\" stroke-linecap=\"round\"/></svg></div></div>\n<div class=\"a sk\" style=\"left:0;top:0;width:0;height:0;z-index:4\"><svg viewBox=\"-50 -130 50 50\" width=\"50\" height=\"50\" style=\"position:absolute;left:-50px;top:-130px;overflow:visible\" shape-rendering=\"geometricPrecision\"><path class=\"o\" d=\"M-36 -123L-36 -101M-28 -102L-15 -114M-27 -91L-7 -91\" stroke=\"#5ee6ff\" stroke-width=\"4.2\" stroke-linecap=\"square\"/><path class=\"i\" d=\"M-36 -123L-36 -101M-28 -102L-15 -114M-27 -91L-7 -91\" stroke=\"#1c36e8\" stroke-width=\"2.2\" stroke-linecap=\"square\"/><path class=\"gc\" d=\"M-36 -123L-36 -101M-28 -102L-15 -114M-27 -91L-7 -91\" stroke=\"#46f8ff\" stroke-width=\"3.6\" stroke-linecap=\"square\" transform=\"translate(-2 0)\"/><path class=\"gm\" d=\"M-36 -123L-36 -101M-28 -102L-15 -114M-27 -91L-7 -91\" stroke=\"#ff2ed8\" stroke-width=\"3.2\" stroke-linecap=\"square\" transform=\"translate(2.2 1)\"/></svg></div>\n        <div class=\"a bub\"><span class=\"pf\" id=\"bub\" data-pf=\"bubbleCover\"></span></div>\n\n        <div class=\"a swb\">\n          <i style=\"--x:-20px;--y:-52px;--w:150px;--h:9px;--j:14px\"><b style=\"--m:96px\"></b></i>\n          <i style=\"--x:40px;--y:-6px;--w:170px;--h:12px;--j:-18px\"><b style=\"--m:34px\"></b></i>\n          <i style=\"--x:-60px;--y:28px;--w:140px;--h:8px;--j:12px\"><b style=\"--m:70px\"></b></i>\n          <i style=\"--x:70px;--y:52px;--w:120px;--h:7px;--j:-10px\"></i>\n        </div>\n      </div>\n    </div>\n    <div class=\"a tw bs bs0\" style=\"left:-183.2px;top:-63.2px;width:22px;height:22px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs1\" style=\"left:-224.5px;top:-41.5px;width:27px;height:27px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs2\" style=\"left:-138.5px;top:-23.5px;width:33px;height:33px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs3\" style=\"left:-184.5px;top:15.5px;width:33px;height:33px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs4\" style=\"left:-222.0px;top:18.0px;width:30px;height:30px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs5\" style=\"left:-250.5px;top:-0.5px;width:21px;height:21px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs6\" style=\"left:70.8px;top:-17.2px;width:16px;height:16px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs7\" style=\"left:125.5px;top:29.5px;width:21px;height:21px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs8\" style=\"left:150.0px;top:-7.0px;width:24px;height:24px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs9\" style=\"left:171.0px;top:-50.0px;width:18px;height:18px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs10\" style=\"left:190.5px;top:-50.5px;width:15px;height:15px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs11\" style=\"left:82.8px;top:11.8px;width:22px;height:22px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs12\" style=\"left:41.0px;top:-44.0px;width:18px;height:18px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n<div class=\"a tw bs bs13\" style=\"left:-59.0px;top:36.0px;width:18px;height:18px\"><svg class=\"c\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gC)\"/></svg><svg class=\"m\" viewBox=\"-12 -12 24 24\"><use href=\"#star\" x=\"-12\" y=\"-12\" width=\"24\" height=\"24\" fill=\"url(#gM)\"/></svg></div>\n  </div>";
const C = { tagA: 'ON-AIR', tagB: '1.23 FM', foot: 'TAVERN × LITE SYSTEM', window: 'TAVERN', program: 'RECENT' };
const COLORS = ['#2a20a2', '#c8203f', '#8934bd', '#1b8fa6', '#d9811a', '#3a6a3a', '#5b3a8a', '#b0306e'];

const wait = ms => new Promise(r => setTimeout(r, reduced() ? 0 : ms));

let seenIntro = false;

export function GlitchHome({ items, onMenu }) {
    const rootRef = useRef(null);
    const stageRef = useRef(null);
    const itemsRef = useRef(items);
    const onMenuRef = useRef(onMenu);
    itemsRef.current = items;
    onMenuRef.current = onMenu;

    // Enhance shelf character cards & section headers & footer while GlitchHome is mounted
    useEffect(() => {
        const lib = rootRef.current?.closest('.tl-library');
        if (!lib) return;
        const offSheets = watchGlitchSheets();

        let foot = lib.querySelector('.tl-gt-foot');
        if (!foot) {
            foot = document.createElement('div');
            foot.className = 'tl-gt-foot';
            foot.innerHTML = `<span class="tag"><span class="pf">${pfSvg('ON-AIR', 1, 1)}</span></span><span class="tag"><span class="pf">${pfSvg('1.23 FM', 1, 1)}</span></span><span class="gl"></span>`;
            lib.append(foot);
        }

        const byName = new Map(itemsRef.current.map(it => [it.name, it]));
        const dressLib = () => {
            lib.querySelectorAll('.tl-section').forEach(sec => {
                const h2 = sec.querySelector('.tl-section-title');
                if (h2 && !sec.querySelector('.tl-gt-strip')) {
                    const strip = document.createElement('div');
                    strip.className = 'tl-gt-strip';
                    strip.textContent = '点一张卡直接接着读';
                    h2.after(strip);
                }
            });
            lib.querySelectorAll('.tl-grid > .tl-book').forEach((bk, i) => {
                bk.style.setProperty('--gt-c', COLORS[i % COLORS.length]);
                const nm = bk.querySelector('.tl-card-name')?.textContent || '';
                const recent = byName.get(nm);
                if (!bk.querySelector('.tl-gt-no')) {
                    const no = document.createElement('span');
                    no.className = 'tl-gt-no';
                    no.innerHTML = `<span class="pf">${pfSvg(pad(i + 1), 1, 1)}</span>`;
                    bk.prepend(no);
                }
                let ft = bk.querySelector('.tl-gt-cft');
                if (!ft) {
                    ft = document.createElement('span');
                    ft.className = 'tl-gt-cft';
                    bk.querySelector('.tl-character')?.append(ft);
                }
                const chNo = recent ? Math.max(1, recent.count || 1) : (i + 1);
                const label = 'CH.' + pad(Math.min(99, chNo));
                if (ft.dataset.label !== label) {
                    ft.dataset.label = label;
                    ft.innerHTML = `<span class="pf">${pfSvg(label, 1, 1)}</span><i></i>`;
                }
            });
        };
        dressLib();
        const mo = new MutationObserver(dressLib);
        mo.observe(lib, { childList: true, subtree: true });

        return () => {
            offSheets();
            mo.disconnect();
            foot?.remove();
            lib.querySelectorAll('.tl-gt-strip, .tl-gt-no, .tl-gt-cft').forEach(e => e.remove());
        };
    }, [items.length]);

    useLayoutEffect(() => {
        const stage = stageRef.current;
        const gp = stage?.querySelector('.gp');
        if (!stage || !gp) return;
        const q = sel => gp.querySelector(sel);
        const hit = q('#hit'), ttl = q('#ttl'), sub = q('#sub'), mscr = q('#mscr');
        const rows = q('#rows'), ribTx = q('#ribTx'), dsc = q('#dsc'), dscTx = q('#dscTx');
        const nO = q('#nO'), nW = q('#nW'), c1 = q('#c1'), c2 = q('.c2'), xb = q('#xb'), bub = q('#bub');
        const fms = gp.querySelectorAll('.fm .pf');
        for (const [el, label] of [[hit, '查看最近故事'], [c1, '下一个故事'], [c2, '继续读 GO'], [xb, '返回封面']]) {
            if (!el) continue;
            el.setAttribute('role', 'button');
            el.tabIndex = 0;
            el.setAttribute('aria-label', label);
        }

        // Inject ⋯ story menu button into turn popup
        let menuB = q('.tl-gt-act');
        if (!menuB) {
            menuB = document.createElement('button');
            menuB.type = 'button';
            menuB.className = 'a tl-gt-act';
            menuB.setAttribute('aria-label', '故事操作');
            menuB.textContent = '⋯';
            q('.k-turn')?.append(menuB);
        }

        let S = 1, mode = 'none', cur = 0, busy = false, alive = true;
        const pfPaint = el => {
            const t = el.dataset.txt != null ? el.dataset.txt : (C[el.dataset.pf] != null ? C[el.dataset.pf] : el.dataset.pf);
            el.innerHTML = pfSvg(t, +el.dataset.pu || 1, S);
        };
        const pfSet = (el, t) => { if (!el) return; el.dataset.txt = t; pfPaint(el); };

        function place(kind) {
            const top = kind === 'turn' ? 324 : 132, bot = 102;
            stage.style.setProperty('--fh', Math.round((top + bot) * S + 22) + 'px');
            gp.style.setProperty('--ay', (12 + top * S).toFixed(1) + 'px');
        }
        function shrink(el, prop, base, max, min) {
            if (!el) return;
            gp.style.setProperty(prop, base + 'px');
            const w = el.scrollWidth;
            if (w > max) gp.style.setProperty(prop, Math.max(min, base * max / w).toFixed(2) + 'px');
        }
        function fitText() {
            if (gp.hidden) return;
            const fb = Math.max(1, .92 / S);
            if (gp.dataset.kind === 'end') {
                shrink(ttl, '--tfz', 30, 158, 16);
                const base = 15 * fb;
                gp.style.setProperty('--sfz', base + 'px');
                if (sub) {
                    sub.style.whiteSpace = 'nowrap';
                    const w = sub.scrollWidth;
                    gp.style.setProperty('--sfz', (w > 160 && w < 208 ? base * 158 / w : base).toFixed(2) + 'px');
                    sub.style.whiteSpace = '';
                }
            } else {
                shrink(ribTx, '--rfz', 13 * fb, 104, 9);
                shrink(dscTx, '--dfz', 13 * fb, 366, 9 * fb);
            }
        }
        function fit() {
            const W = stage.clientWidth || 360;
            S = Math.min(1.3, (W - 6) / 414);
            gp.style.setProperty('--s', S.toFixed(4));
            gp.style.setProperty('--fb', Math.max(1, .92 / S).toFixed(3));
            gp.style.setProperty('--ax', (W / 2 - 3 * S).toFixed(1) + 'px');
            place(gp.dataset.kind || 'end');
            gp.querySelectorAll('[data-pf]').forEach(pfPaint);
            fitText();
        }
        function chars(el, text, t0, step) {
            if (!el) return;
            el.textContent = '';
            const a = [...String(text)];
            a.forEach((c, i) => {
                const s = document.createElement('span');
                s.dataset.c = c; s.textContent = c;
                s.style.setProperty('--t', (t0 + (a.length - 1 - i) * step) + 'ms');
                el.appendChild(s);
            });
        }
        function curList() { return itemsRef.current || []; }
        function fillCover() {
            const list = curList(), c = list[0];
            if (c) {
                chars(ttl, c.name, 255, 14);
                const subText = [c.story, c.count ? `${c.count} 条` : '', c.when].filter(Boolean).join(' · ') || '点一下继续读';
                chars(sub, subText, 328, 6);
                if (mscr?.firstChild) mscr.firstChild.textContent = [...c.name][0] || '★';
            } else {
                chars(ttl, '故障终端', 255, 14);
                chars(sub, '从下面挑一个角色开始读', 328, 6);
                if (mscr?.firstChild) mscr.firstChild.textContent = '★';
            }
            pfSet(bub, '»[ NOW PLAYING ]');
            fms.forEach(e => pfSet(e, C.tagB));
        }
        function fillRows(idx) {
            if (!rows) return;
            const list = curList();
            rows.textContent = '';
            list.forEach((c, k) => {
                const r = document.createElement('div');
                r.className = 'row' + (k === idx ? ' on' : '');
                r.dataset.i = k;
                r.setAttribute('role', 'button');
                r.tabIndex = 0;
                r.setAttribute('aria-label', '选择故事：' + c.name);
                r.style.setProperty('--t', (250 + k * 28) + 'ms');
                r.innerHTML = '<span class="pf cn"></span><span class="nm"></span>';
                pfSet(r.firstChild, 'CH' + pad(k + 1));
                r.lastChild.textContent = c.name;
                rows.appendChild(r);
            });
        }
        function fillTurn(idx, fromNum) {
            const list = curList(), c = list[idx];
            if (!c) return;
            if (ribTx) ribTx.textContent = c.name;
            if (dscTx) dscTx.textContent = c.snippet || [c.story, c.when].filter(Boolean).join(' · ') || c.name;
            const num = c.count || (idx + 1);
            if (nO) nO.textContent = pad(Math.min(99, fromNum));
            if (nW) nW.textContent = pad(Math.min(99, num));
            const l1 = q('.c1 .l'), l2 = q('.c2 .l');
            if (l1) l1.textContent = c.count ? '条数' : '故事';
            if (l2) l2.textContent = '继续读';
            pfSet(bub, '»[ CH.' + pad(idx + 1) + ' ]');
            fms.forEach(e => pfSet(e, '1.' + pad(idx + 1) + ' FM'));
            fillRows(idx);
            if (menuB) menuB.setAttribute('aria-label', `${c.story || c.name}的操作`);
        }
        function setKind(kind) {
            gp.dataset.kind = kind;
            const ke = q('.k-end'), kt = q('.k-turn');
            if (ke) ke.hidden = kind !== 'end';
            if (kt) kt.hidden = kind !== 'turn';
            gp.querySelectorAll('.ga').forEach(e => { e.hidden = kind !== 'end'; });
            gp.querySelectorAll('.gb').forEach(e => { e.hidden = kind !== 'turn'; });
            q('.pa')?.classList.toggle('on', kind === 'end');
            q('.pb')?.classList.toggle('on', kind === 'turn');
        }

        let off = false, idleT = 0, sleepy = false;
        const pause = () => gp.classList.toggle('paused', off || document.hidden || sleepy);
        function wake() {
            sleepy = false; pause();
            clearTimeout(idleT);
            idleT = setTimeout(() => { sleepy = true; pause(); }, 20000);
        }

        function open(kind, still) {
            setKind(kind); place(kind);
            gp.dataset.state = ''; gp.hidden = false; fitText();
            gp.classList.toggle('still', !!still);
            void gp.offsetWidth;
            stage.dataset.blur = kind === 'end' ? '1' : '0';
            gp.dataset.state = 'open';
            if (still && gp.getAnimations) {
                gp.getAnimations({ subtree: true }).forEach(a => {
                    if (a.animationName && !/clk|ghf|gw|gts|tw|star|blink|tapk/.test(a.animationName)) a.finish();
                });
            }
            wake();
        }
        async function close() {
            if (gp.hidden) return;
            const k = gp.dataset.kind;
            if (!reduced()) { gp.dataset.state = k === 'turn' ? 'standup' : 'scatter'; await wait(k === 'turn' ? 190 : 150); }
            gp.dataset.state = 'closing';
            if (stage.dataset.blur === '1') stage.dataset.blur = '0';
            await wait(reduced() ? 90 : 200);
            gp.hidden = true; gp.dataset.state = '';
        }
        async function toTurn(idx) {
            if (busy || !curList().length) return;
            busy = true;
            await close();
            if (!alive) return;
            cur = Math.max(0, Math.min(curList().length - 1, idx));
            const num = curList()[cur]?.count || (cur + 1);
            fillTurn(cur, Math.max(0, num - 1));
            open('turn');
            mode = 'turn';
            await wait(560);
            busy = false;
        }
        async function toCover() {
            if (busy) return;
            busy = true;
            await close();
            if (!alive) return;
            fillCover();
            open('end');
            mode = 'cover';
            await wait(420);
            busy = false;
        }
        const fx = (el, frames, o) => (reduced() || !el?.animate) ? null : el.animate(frames, Object.assign({ fill: 'none' }, o));
        function switchTo(j) {
            const list = curList();
            if (busy || mode !== 'turn' || gp.dataset.state !== 'open' || list.length < 2) return;
            j = (j + list.length) % list.length;
            if (j === cur) return;
            const prev = list[cur]?.count || (cur + 1);
            const next = list[j]?.count || (j + 1);
            const down = next >= prev;
            cur = j; wake();
            fillTurn(j, prev); fitText();
            const sy = down ? 1 : -1;
            fx(nO, [{ transform: 'none', opacity: 1 }, { transform: `translateY(${8 * sy}px)`, opacity: .7, color: '#ff2fd2', offset: .45 }, { transform: `translateY(${19 * sy}px)`, opacity: 0 }], { duration: 75, easing: 'cubic-bezier(.4,0,.8,.6)' });
            fx(nW, [{ transform: `translateY(${-19 * sy}px)`, color: '#2fe8ff', textShadow: '2px 0 #ff2fd2' }, { transform: 'none', color: '#2b30c4', textShadow: 'none' }], { duration: 115, easing: 'cubic-bezier(.3,.6,.4,1)' });
            fx(q('.rib'), [{ opacity: 0, transform: 'translateX(-14px) scaleX(.35)' }, { opacity: .75, transform: 'translateX(8px) scaleX(1.04)', offset: .3 }, { opacity: 1, transform: 'none' }], { duration: 90, delay: 20, easing: 'steps(4, end)', fill: 'backwards' });
            fx(dsc, [{ opacity: 0, transform: 'translateX(14px) scaleX(1.4)' }, { opacity: 1, transform: 'translateX(-5px) scaleX(1.1)', offset: .4 }, { opacity: 1, transform: 'none' }], { duration: 120, delay: 40, easing: 'steps(4, end)', fill: 'backwards' });
            gp.querySelectorAll('.mb').forEach((m, k) => fx(m, [{ opacity: 0 }, { opacity: 1, offset: .12 }, { opacity: 1, offset: .5 }, { opacity: .3, offset: .62 }, { opacity: 1, offset: .75 }, { opacity: 0 }], { duration: 210, delay: k * 25, easing: 'steps(1, end)' }));
            gp.querySelectorAll('.swb i').forEach((b, k) => {
                const jj = parseFloat(b.style.getPropertyValue('--j')) || 10;
                fx(b, [{ opacity: 0, easing: 'steps(1,end)' }, { opacity: 1, transform: `translateX(${jj * 1.3}px) scaleX(1.15)`, offset: .15, easing: 'steps(1,end)' }, { opacity: 1, transform: `translateX(${-jj}px) scaleX(1.25)`, offset: .5, easing: 'steps(1,end)' }, { opacity: 0, transform: 'none' }], { duration: 150, delay: k * 16 });
            });
        }
        async function enterStory() {
            const item = curList()[cur];
            if (!item || busy) return;
            busy = true;
            if (!reduced()) {
                fx(q('.c2 .v'), [{ color: '#27e8ff', textShadow: '3px 0 #ff2fd2' }, { color: '#ff2fd2', textShadow: '-3px 0 #27e8ff', offset: .4 }, { color: '#141414', textShadow: 'none' }], { duration: 240, easing: 'steps(6, end)' });
                await wait(240);
                await close();
            }
            await blocks(true);
            if (!alive) { await blocks(false); return; }
            item.open();
            await wait(60);
            await blocks(false);
            busy = false;
        }

        const onHitDown = e => { hit._x = e.clientX; hit._y = e.clientY; };
        const onHitUp = e => {
            if (hit._x == null) return;
            const dx = e.clientX - hit._x, dy = e.clientY - hit._y;
            hit._x = null;
            if (mode === 'cover' && Math.abs(dx) < 12 && Math.abs(dy) < 12) toTurn(0);
            else if (mode === 'turn' && Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy)) switchTo(cur + (dx < 0 ? 1 : -1));
        };
        const onC1 = () => switchTo(cur + 1);
        const onC2 = () => enterStory();
        const onXb = () => toCover();
        const onRows = e => { const r = e.target.closest('.row'); if (r) switchTo(+r.dataset.i); };
        const onAct = e => {
            e.stopPropagation();
            const item = curList()[cur];
            if (item && onMenuRef.current) onMenuRef.current(item.entry);
        };
        const onKey = e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const el = e.target.closest('[role="button"]');
            if (!el || !stage.contains(el)) return;
            e.preventDefault();
            wake();
            if (el === hit) { if (mode === 'cover') toTurn(0); }
            else el.click();
        };
        stage.addEventListener('keydown', onKey);

        hit?.addEventListener('pointerdown', onHitDown);
        hit?.addEventListener('pointerup', onHitUp);
        c1?.addEventListener('click', onC1);
        c2?.addEventListener('click', onC2);
        xb?.addEventListener('click', onXb);
        rows?.addEventListener('click', onRows);
        menuB?.addEventListener('click', onAct);

        stage.addEventListener('pointerdown', wake, { passive: true });
        document.addEventListener('visibilitychange', pause);
        const io = window.IntersectionObserver ? new IntersectionObserver(es => { off = !es[es.length - 1].isIntersecting; pause(); }) : null;
        io?.observe(stage);
        const ro = window.ResizeObserver ? new ResizeObserver(() => requestAnimationFrame(fit)) : null;
        ro?.observe(stage);

        // WebGL character mesh on capable devices
        let offGl = null;
        const canGl = (navigator.deviceMemory ?? 4) >= 4 && !/TauriTavern/i.test(navigator.userAgent) && !reduced();
        if (canGl) {
            import('./glitch-char-gl.js').then(m => { if (alive) offGl = m.attachCharGl(gp); }).catch(() => {});
        }

        fillCover();
        fit();
        const fromStory = takeGlitchReturn();
        if (fromStory) {
            gp.hidden = true;
            mode = 'cover';
            blocks(false).then(() => { if (alive) open('end', false); });
        } else {
            const still = seenIntro;
            seenIntro = true;
            open('end', still);
            mode = 'cover';
        }

        return () => {
            alive = false;
            stage.removeEventListener('keydown', onKey);
            clearTimeout(idleT);
            hit?.removeEventListener('pointerdown', onHitDown);
            hit?.removeEventListener('pointerup', onHitUp);
            c1?.removeEventListener('click', onC1);
            c2?.removeEventListener('click', onC2);
            xb?.removeEventListener('click', onXb);
            rows?.removeEventListener('click', onRows);
            menuB?.removeEventListener('click', onAct);
            stage.removeEventListener('pointerdown', wake);
            document.removeEventListener('visibilitychange', pause);
            io?.disconnect();
            ro?.disconnect();
            offGl?.();
        };
    }, []);

    // Refresh cover text if items update while on cover
    useEffect(() => {
        const stage = stageRef.current, gp = stage?.querySelector('.gp');
        if (!gp || gp.dataset.kind !== 'end') return;
        const c = items[0];
        if (!c) return;
        const ttl = gp.querySelector('#ttl'), sub = gp.querySelector('#sub'), mscr = gp.querySelector('#mscr');
        if (ttl && ttl.textContent !== c.name) {
            ttl.textContent = c.name;
            if (sub) sub.textContent = [c.story, c.count ? `${c.count} 条` : '', c.when].filter(Boolean).join(' · ') || '点一下继续读';
            if (mscr?.firstChild) mscr.firstChild.textContent = [...c.name][0] || '★';
        }
    }, [items]);

    return (
        <div class="tl-gt" ref={rootRef}>
            <div class="tl-gt-urlbar"><span>‹ ›</span><span>⟳</span><span class="f">»[ TAVERN LITE ] / 书架</span></div>
            <div class="tl-front tl-gt-stage" ref={stageRef}>
                <div class="glyph" /><div class="floor" />
                <span class="tl-star tw" style="right:14px;bottom:18px;--z:46px"><svg viewBox="-12 -12 24 24"><defs><radialGradient id="gtSG0"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="#8ef6ff"/><stop offset="1" stop-color="#2f6cff"/></radialGradient></defs><path d="M0-12Q.9-.9 9 0Q.9 .9 0 12Q-.9 .9-9 0Q-.9-.9 0-12Z" fill="url(#gtSG0)"/></svg></span>
                <span class="tl-star" style="left:10px;top:16px;--z:30px"><svg viewBox="-12 -12 24 24"><defs><radialGradient id="gtSG1"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="#ffb8f4"/><stop offset="1" stop-color="#c22ad6"/></radialGradient></defs><path d="M0-12Q.9-.9 9 0Q.9 .9 0 12Q-.9 .9-9 0Q-.9-.9 0-12Z" fill="url(#gtSG1)"/></svg></span>
                <span class="tl-star" style="right:34%;top:10px;--z:18px"><svg viewBox="-12 -12 24 24"><defs><radialGradient id="gtSG2"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="#8ef6ff"/><stop offset="1" stop-color="#3a2fd2"/></radialGradient></defs><path d="M0-12Q.9-.9 9 0Q.9 .9 0 12Q-.9 .9-9 0Q-.9-.9 0-12Z" fill="url(#gtSG2)"/></svg></span>
                <div class="tl-gt-gp-host" dangerouslySetInnerHTML={{ __html: GP_HTML }} />
            </div>
        </div>
    );
}

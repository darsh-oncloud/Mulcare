/**
 * @NApiVersion 2.1
 * @NScriptType WorkflowActionScript
 *
 * OPTIMIZATION NOTES (vs original):
 * 1. Address lookups are now BATCHED per distinct customer instead of run
 *    once per RSM. If several RSMs share a customer, this collapses N
 *    searches into 1 search per unique customer.
 * 2. Invoice creation and Rep Commission edit now use STANDARD mode
 *    (isDynamic:false) with setSublistValue/insertLine/removeLine instead
 *    of dynamic mode's selectNewLine/setCurrentSublistValue/commitLine.
 *    Dynamic mode re-sources/recalculates the record after every single
 *    field set - standard mode skips that entirely, which is the biggest
 *    speed gain when a record has several lines.
 * 3. Removed the extra runPaged().count() search - it was a second round
 *    trip to the search index used only for a log line. Count is now
 *    tracked while iterating the results we already have.
 * 4. Reduced per-line log.debug calls and removed full JSON.stringify of
 *    the whole map on every run - logging has real overhead when enabled.
 */
define(['N/record','N/search','N/log','N/runtime'], function(record, search, log, runtime) {

  function isEmpty(v){ return v === null || v === undefined || String(v).trim() === ''; }
  function toNum(v){
    var n = parseFloat(String(v || '').replace(/,/g,''));
    return isNaN(n) ? 0 : n;
  }

  // ------------------------------------------------------------------
  // TIMING HELPER - logs how long the PREVIOUS stage took and resets
  // the clock for the next one. Uses log.audit so it always shows up
  // regardless of the account's default logging level.
  // Usage: var timer = makeTimer(); ... timer('SEARCH LINES');
  // ------------------------------------------------------------------
  function makeTimer() {
    var start = Date.now();
    var last = start;
    return function(stageLabel) {
      var now = Date.now();
      log.audit('TIMER: ' + stageLabel, (now - last) + ' ms (total so far: ' + (now - start) + ' ms)');
      last = now;
    };
  }

  // ------------------------------------------------------------------
  // Batched address lookup: one search per DISTINCT customer, covering
  // every RSM that belongs to that customer in a single call.
  // Returns { rsmId: addressId, ... }
  // ------------------------------------------------------------------
  function getAddressMapForCustomer(customerId, rsmIds) {

    var addressIdColumn = search.createColumn({ name: 'addressinternalid', join: 'Address' });
    var rsmColumn = search.createColumn({ name: 'custrecord_pm_reg_sales_mgr', join: 'Address' });

    var results = search.create({
      type: search.Type.CUSTOMER,
      filters: [
        ['internalidnumber', 'equalto', String(customerId)],
        'AND',
        ['address.custrecord_pm_reg_sales_mgr', 'anyof', rsmIds]
      ],
      columns: [addressIdColumn, rsmColumn]
    }).run().getRange({ start: 0, end: 1000 });

    var map = {};
    for (var i = 0; i < results.length; i++) {
      var addrId = results[i].getValue(addressIdColumn);
      var rsmRaw = results[i].getValue(rsmColumn);
      if (isEmpty(rsmRaw) || isEmpty(addrId)) continue;

      // handle both single-select and comma-separated multi-select values
      var ids = String(rsmRaw).split(',');
      for (var k = 0; k < ids.length; k++) {
        var idTrim = ids[k].trim();
        if (idTrim) map[idTrim] = addrId;
      }
    }

    log.debug('ADDRESS MAP (customer ' + customerId + ')', map);
    return map;
  }

  function onAction(context) {

    var repRec = context.newRecord;
    var repId  = repRec.id;
    var createdByEmployeeId = parseInt(runtime.getCurrentUser().id, 10);

    log.audit('START', 'Rep Commission ID: ' + repId);
    var timer = makeTimer();

    var invoiceIds = [];
    var rsmMap = {};     // { rsmId: { customer, location, subsidiary, lines:[{item,qty,rate}] } }
    var invByRsm = {};   //  { rsmId : invoiceId }

    // T&D Manager employees for sales team
    var tndSalesTeamMap = {};

    var repCommissionStatus = runtime.getCurrentScript().getParameter({
      name: 'custscript_rep_commission_status'
    });

    // ======================================================
    // SEARCH LINES + GET estgrossprofit via FORMULA
    // ======================================================
    var s = search.create({
      type: 'transaction',
      settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
      filters: [
        ['type','anyof','CuTrSale107'],
        'AND',
        ['internalid','anyof', String(repId)],
        'AND',
        ['mainline','is','F'],
        'AND',
        ['taxline','is','F'],
        'AND',
        ['cogs','is','F']
      ],
      columns: [
        search.createColumn({ name:'entity' }),
        search.createColumn({ name:'subsidiary' }),
        search.createColumn({ name:'location' }),
        search.createColumn({ name:'item' }),
        search.createColumn({ name:'quantity' }),
        search.createColumn({ name:'custcol_rsm_sales_rep' }),
        search.createColumn({ name:'custcol_tnd_commission' }),
        search.createColumn({ name:'custcol_td_manager' }),
        search.createColumn({ name: 'amount' }),
        search.createColumn({
          name:'formulanumeric',
          formula:'{estgrossprofit}',
          label:'estgrossprofit'
        })
      ]
    });

    var lineCount = 0;

    s.run().each(function(r){

      lineCount++;

      var customer   = r.getValue({ name:'entity' });
      var subsidiary = r.getValue({ name:'subsidiary' });
      var locationId = r.getValue({ name:'location' });
      var item       = r.getValue({ name:'item' });
      var qty        = toNum(r.getValue({ name:'quantity' })) || 1;
      var rsm        = r.getValue({ name:'custcol_rsm_sales_rep' });
      var tndManager = r.getValue({ name:'custcol_tnd_commission' });
      var tndSalesTeam = r.getValue({ name:'custcol_td_manager' });
      var amount     = toNum(r.getValue({ name:'formulanumeric' })) || 0;
      var repSalesAmount = toNum(r.getValue({ name: 'amount' }));

      if (!isEmpty(tndSalesTeam)) {
        tndSalesTeamMap[tndSalesTeam] = true;
      }

      if (isEmpty(customer) || isEmpty(item) || isEmpty(rsm) || !amount) return true;

      if (!rsmMap[rsm]) {
        rsmMap[rsm] = {
          customer: customer,
          subsidiary: subsidiary,
          location: locationId,
          lines: []
        };
      }

      // no merging
      rsmMap[rsm].lines.push({ item:item, qty:qty, rate:amount, tndManager:tndManager, repSalesAmount: repSalesAmount });

      return true;
    });

    log.audit('SEARCH COUNT', lineCount);
    timer('STAGE 1 - Transaction line search + grouping');

    if (!lineCount) {
      log.audit('NO LINES', 'No detail lines found for Rep Commission ' + repId);
      return '';
    }

    log.audit('RSM GROUPS', Object.keys(rsmMap).length + ' RSM(s) found');

    // ======================================================
    // BATCH ADDRESS LOOKUP: group RSMs by customer so we run
    // one address search per distinct customer, not per RSM.
    // ======================================================
    var customerRsmGroups = {}; // { customerId: [rsmId, ...] }
    for (var rsmKey in rsmMap) {
      var custId = rsmMap[rsmKey].customer;
      if (!customerRsmGroups[custId]) customerRsmGroups[custId] = [];
      customerRsmGroups[custId].push(rsmKey);
    }

    var addressMap = {}; // { rsmId: addressId }
    for (var custIdKey in customerRsmGroups) {
      try {
        var partialMap = getAddressMapForCustomer(custIdKey, customerRsmGroups[custIdKey]);
        for (var mapKey in partialMap) addressMap[mapKey] = partialMap[mapKey];
      } catch (eAddr) {
        log.error('ADDRESS LOOKUP ERROR (customer ' + custIdKey + ')', eAddr);
      }
    }

    timer('STAGE 2 - Batched address lookup (' + Object.keys(customerRsmGroups).length + ' customer search(es))');

    // ======================================================
    // CREATE 1 INVOICE PER RSM  (standard/non-dynamic mode)
    // ======================================================
    for (var rsmId in rsmMap) {
      try {
        var data = rsmMap[rsmId];

        log.audit('INVOICE START', 'RSM=' + rsmId + ' cust=' + data.customer);

        var inv = record.create({ type: record.Type.INVOICE, isDynamic: false });

        inv.setValue({ fieldId:'entity', value: parseInt(data.customer,10) });

        var addressId = addressMap[rsmId];
        if (!isEmpty(addressId)) {
          inv.setValue({ fieldId: 'shipaddresslist', value: String(addressId) });
        }

        inv.setValue({ fieldId:'custbodypm_created_by', value: createdByEmployeeId });

        if (!isEmpty(data.subsidiary)) {
          try { inv.setValue({ fieldId:'subsidiary', value: parseInt(data.subsidiary,10) }); } catch(e){}
        }

        if (!isEmpty(data.location)) {
          inv.setValue({ fieldId:'location', value: parseInt(data.location,10) });
        } else {
          throw 'Location is mandatory but search returned empty location.';
        }

        // Link back to Rep Commission
        inv.setValue({ fieldId:'custbody_related_rep_commission', value: repId });

        // Lines - standard mode: insertLine + setSublistValue (no recalc per field)
        for (var j=0; j<data.lines.length; j++){
          var ln = data.lines[j];

          inv.insertLine({ sublistId:'item', line:j });
          inv.setSublistValue({ sublistId:'item', fieldId:'item', line:j, value: parseInt(ln.item,10) });
          inv.setSublistValue({ sublistId:'item', fieldId:'price', line:j, value: -1 }); // custom price
          inv.setSublistValue({ sublistId:'item', fieldId:'quantity', line:j, value: ln.qty });
          inv.setSublistValue({ sublistId:'item', fieldId:'rate', line:j, value: ln.rate });
          inv.setSublistValue({ sublistId:'item', fieldId:'custcol_snp_rep_sales_amount', line:j, value: ln.repSalesAmount });

          if (!isEmpty(ln.tndManager)) {
            try {
              inv.setSublistValue({ sublistId:'item', fieldId:'custcol_tnd_commission', line:j, value: parseInt(ln.tndManager,10) });
            } catch (eTnd) {
              log.error('T&D MANAGER LINE SET ERROR', eTnd);
            }
          }

          try { inv.setSublistValue({ sublistId:'item', fieldId:'location', line:j, value: parseInt(data.location,10) }); } catch(e){}
        }

        // Fix sales team total 200%: remove any auto-added lines first (cheap in standard mode)
        var stCount = inv.getLineCount({ sublistId:'salesteam' });
        for (var x = stCount - 1; x >= 0; x--) {
          inv.removeLine({ sublistId:'salesteam', line:x, ignoreRecalc:true });
        }

        // Add ONLY RSM at 100%
        inv.insertLine({ sublistId:'salesteam', line:0 });
        inv.setSublistValue({ sublistId:'salesteam', fieldId:'employee', line:0, value: parseInt(rsmId,10) });
        inv.setSublistValue({ sublistId:'salesteam', fieldId:'isprimary', line:0, value: true });
        inv.setSublistValue({ sublistId:'salesteam', fieldId:'contribution', line:0, value: 100 });

        timer('  RSM ' + rsmId + ' - build invoice fields/lines (' + data.lines.length + ' line(s))');

        var invId = inv.save();
        log.audit('INVOICE CREATED', invId);

        timer('  RSM ' + rsmId + ' - inv.save() call');

        invoiceIds.push(invId);
        invByRsm[rsmId] = invId;

      } catch (eInv) {
        log.error('INVOICE ERROR (RSM ' + rsmId + ')', eInv);
      }
    }

    timer('STAGE 3 - All invoices created (' + invoiceIds.length + ' invoice(s))');

    // ======================================================
    // UPDATE REP COMMISSION: set invoice on EACH LINE + sales team
    // (standard/non-dynamic mode)
    // ======================================================
    if (invoiceIds.length) {

      var repEdit = record.load({ type: repRec.type, id: repId, isDynamic: false });
      timer('  Rep Commission - record.load()');

      if (!isEmpty(repCommissionStatus)) {
        try {
          repEdit.setValue({ fieldId: 'transtatus', value: repCommissionStatus });
        } catch (eStatus) {
          log.error('STATUS UPDATE ERROR', eStatus);
        }
      }

      // Set custcol_related_invoice on each line - direct sublist write, no line selection needed
      var itemLineCount = repEdit.getLineCount({ sublistId: 'item' });

      for (var i2 = 0; i2 < itemLineCount; i2++) {

        var lineRsm = repEdit.getSublistValue({
          sublistId: 'item',
          fieldId: 'custcol_rsm_sales_rep',
          line: i2
        });

        var lineInv = invByRsm[lineRsm];

        if (!isEmpty(lineRsm) && !isEmpty(lineInv)) {
          repEdit.setSublistValue({
            sublistId: 'item',
            fieldId: 'custcol_related_invoice',
            line: i2,
            value: parseInt(lineInv, 10)
          });
        }
      }

      // Clear & re-add sales team on rep commission record
      var repStCount = repEdit.getLineCount({ sublistId:'salesteam' });
      for (var rr = repStCount - 1; rr >= 0; rr--) {
        repEdit.removeLine({ sublistId:'salesteam', line: rr, ignoreRecalc:true });
      }

      var stLine = 0;
      for (var rsm3 in rsmMap) {
        repEdit.insertLine({ sublistId:'salesteam', line: stLine });
        repEdit.setSublistValue({ sublistId:'salesteam', fieldId:'employee', line: stLine, value: parseInt(rsm3,10) });
        stLine++;
      }

      // Add T&D Manager employees with 0%
      for (var tndEmp in tndSalesTeamMap) {
        if (rsmMap[tndEmp]) continue; // skip if already added as RSM
        repEdit.insertLine({ sublistId:'salesteam', line: stLine });
        repEdit.setSublistValue({ sublistId:'salesteam', fieldId:'employee', line: stLine, value: parseInt(tndEmp,10) });
        repEdit.setSublistValue({ sublistId:'salesteam', fieldId:'contribution', line: stLine, value: 0 });
        stLine++;
      }

      timer('  Rep Commission - build lines/salesteam (' + itemLineCount + ' item line(s))');

      repEdit.save();
      log.audit('REP UPDATED', 'Line invoices updated + Sales Team updated');

      timer('STAGE 4 - repEdit.save() call');

    } else {
      log.audit('NO INVOICES', 'No invoices created (all lines had amount=0 or missing RSM)');
    }

    log.audit('END', 'Script Completed');
    timer('TOTAL - script end (should match sum of stages above)');
    return invoiceIds.join(',');
  }
  return { onAction: onAction };
});
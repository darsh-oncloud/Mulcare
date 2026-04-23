/**
 * @NApiVersion 2.1
 * @NScriptType WorkflowActionScript
 */
define(['N/record','N/search','N/log','N/runtime'], function(record, search, log, runtime) {

  function isEmpty(v){ return v === null || v === undefined || String(v).trim() === ''; }
  function toNum(v){
    var n = parseFloat(String(v || '').replace(/,/g,''));
    return isNaN(n) ? 0 : n;
  }

  function onAction(context) {

    var repRec = context.newRecord;
    var repId  = repRec.id;

    log.audit('START', 'Rep Commission ID: ' + repId);

    var invoiceIds = [];
    var rsmMap = {};     // { rsmId: { customer, location, subsidiary, lines:[{item,qty,rate}] } }
    var invByRsm = {};   //  { rsmId : invoiceId }

    //  NEW: get status from parameter
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
        search.createColumn({
          name:'formulanumeric',
          formula:'{estgrossprofit}',
          label:'estgrossprofit'
        })
      ]
    });

    var cnt = s.runPaged().count;
    log.audit('SEARCH COUNT', cnt);

    if (!cnt) {
      log.audit('NO LINES', 'No detail lines found for Rep Commission ' + repId);
      return '';
    }

    s.run().each(function(r){

      var customer   = r.getValue({ name:'entity' });
      var subsidiary = r.getValue({ name:'subsidiary' });
      var locationId = r.getValue({ name:'location' });
      var item       = r.getValue({ name:'item' });
      var qty        = toNum(r.getValue({ name:'quantity' })) || 1;
      var rsm        = r.getValue({ name:'custcol_rsm_sales_rep' });

      var amount     = toNum(r.getValue({ name:'formulanumeric' })) || 0;

      log.debug('LINE', { customer:customer, subsidiary:subsidiary, location:locationId, item:item, qty:qty, rsm:rsm, amount:amount });

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
      rsmMap[rsm].lines.push({ item:item, qty:qty, rate:amount });

      return true;
    });

    log.audit('GROUP RESULT', JSON.stringify(rsmMap));

    // ======================================================
    // CREATE 1 INVOICE PER RSM
    // ======================================================
    for (var rsmId in rsmMap) {
      try {
        var data = rsmMap[rsmId];

        log.audit('INVOICE START', 'RSM=' + rsmId + ' cust=' + data.customer);

        var inv = record.create({ type: record.Type.INVOICE, isDynamic: true });

        inv.setValue({ fieldId:'entity', value: parseInt(data.customer,10) });

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

        // Lines
        for (var j=0; j<data.lines.length; j++){
          var ln = data.lines[j];

          inv.selectNewLine({ sublistId:'item' });
          inv.setCurrentSublistValue({ sublistId:'item', fieldId:'item', value: parseInt(ln.item,10) });
          inv.setCurrentSublistValue({ sublistId:'item', fieldId:'price', value: -1 }); // custom price
          inv.setCurrentSublistValue({ sublistId:'item', fieldId:'quantity', value: ln.qty });
          inv.setCurrentSublistValue({ sublistId:'item', fieldId:'rate', value: ln.rate });

          // line location (safe)
          try { inv.setCurrentSublistValue({ sublistId:'item', fieldId:'location', value: parseInt(data.location,10) }); } catch(e){}

          inv.commitLine({ sublistId:'item' });
        }

        //  Fix sales team total 200%: remove auto-added lines first
        var stCount = inv.getLineCount({ sublistId:'salesteam' });
        for (var x = stCount - 1; x >= 0; x--) {
          inv.removeLine({ sublistId:'salesteam', line:x, ignoreRecalc:true });
        }

        // Add ONLY RSM at 100%
        inv.selectNewLine({ sublistId:'salesteam' });
        inv.setCurrentSublistValue({ sublistId:'salesteam', fieldId:'employee', value: parseInt(rsmId,10) });
        inv.setCurrentSublistValue({ sublistId:'salesteam', fieldId:'isprimary', value: true });
        inv.setCurrentSublistValue({ sublistId:'salesteam', fieldId:'contribution', value: 100 });
        inv.commitLine({ sublistId:'salesteam' });

        var invId = inv.save();
        log.audit('INVOICE CREATED', invId);

        invoiceIds.push(invId);
        invByRsm[rsmId] = invId; //  store mapping

      } catch (eInv) {
        log.error('INVOICE ERROR (RSM ' + rsmId + ')', eInv);
      }
    }

    // ======================================================
    // UPDATE REP COMMISSION: set invoice on EACH LINE + sales team
    // ======================================================
    if (invoiceIds.length) {

      var repEdit = record.load({ type: repRec.type, id: repId, isDynamic: true });

      //  NEW: set status from parameter
      if (!isEmpty(repCommissionStatus)) {
        try {
          repEdit.setValue({
            fieldId: 'transtatus',
            value: repCommissionStatus
          });
        } catch (eStatus) {
          log.error('STATUS UPDATE ERROR', eStatus);
        }
      }

      //  Set custcol_related_invoice on each line (dynamic mode)
      var itemLineCount = repEdit.getLineCount({ sublistId: 'item' });

      for (var i2 = 0; i2 < itemLineCount; i2++) {

        var lineRsm = repEdit.getSublistValue({
          sublistId: 'item',
          fieldId: 'custcol_rsm_sales_rep',
          line: i2
        });

        var lineInv = invByRsm[lineRsm];

        if (!isEmpty(lineRsm) && !isEmpty(lineInv)) {

          repEdit.selectLine({ sublistId: 'item', line: i2 });

          repEdit.setCurrentSublistValue({
            sublistId: 'item',
            fieldId: 'custcol_related_invoice',
            value: parseInt(lineInv, 10)
          });

          repEdit.commitLine({ sublistId: 'item' });
        }
      }

      // Clear & re-add sales team on rep commission record (as you had)
      var repStCount = repEdit.getLineCount({ sublistId:'salesteam' });
      for (var rr = repStCount - 1; rr >= 0; rr--) {
        repEdit.removeLine({ sublistId:'salesteam', line: rr, ignoreRecalc:true });
      }

      for (var rsm3 in rsmMap) {
        repEdit.selectNewLine({ sublistId:'salesteam' });
        repEdit.setCurrentSublistValue({ sublistId:'salesteam', fieldId:'employee', value: parseInt(rsm3,10) });
        repEdit.commitLine({ sublistId:'salesteam' });
      }

      repEdit.save();
      log.audit('REP UPDATED', 'Line invoices updated + Sales Team updated');

    } else {
      log.audit('NO INVOICES', 'No invoices created (all lines had amount=0 or missing RSM)');
    }

    log.audit('END', 'Script Completed');
    return invoiceIds.join(',');
  }

  return { onAction: onAction };
});
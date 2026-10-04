//! Undo replay plans retain original arguments and distinguish refusals before mutation.
use super::*;
use crate::bridge::remote_adapter::READ_ONLY_INVOKES;
use retention::TransactionRecord;
use std::rc::Weak;

pub(super) struct RecoveryPlan {
    record: Weak<RefCell<Value>>,
    key: String,
    prior_state: Option<Value>,
    retried: bool,
    steps: Vec<Rc<RefCell<Value>>>,
}
pub(super) struct UndoRefusal {
    pub record: TransactionRecord,
    pub message: String,
}
struct WatchedAdapter {
    adapter: Rc<dyn AsyncLiveAdapter>,
    watches: Vec<Rc<Cell<usize>>>,
}
impl WatchedAdapter {
    fn begin(&self, operation: &str) -> bool {
        let changes = !READ_ONLY_INVOKES.contains(&operation);
        if changes {
            for watch in &self.watches {
                watch.set(watch.get() + 1);
            }
        }
        changes
    }
    fn finish<T>(&self, changes: bool, result: Result<T, LiveError>) -> Result<T, LiveError> {
        if changes && result.as_ref().is_err_and(|error| matches!(error, LiveError::MutationNotDispatched(_)) || nothing_changed(error)) {
            for watch in &self.watches {
                watch.set(watch.get() - 1);
            }
        }
        result
    }
}
impl LiveAdapter for WatchedAdapter {
    fn status(&self) -> Result<LiveStatus, LiveError> {
        self.adapter.status()
    }
    fn snapshot(&self) -> Result<LiveSnapshot, LiveError> {
        self.adapter.snapshot()
    }
    fn get(&self, r: &LiveRef) -> Result<Option<Value>, LiveError> {
        self.adapter.get(r)
    }
    fn invoke(&self, i: &LiveInvocation) -> Result<Value, LiveError> {
        let changes = self.begin(&i.operation);
        self.finish(changes, self.adapter.invoke(i))
    }
    fn subscribe(&self, l: LiveListener) -> Result<Unsubscribe, LiveError> {
        self.adapter.subscribe(l)
    }
    fn reconnect(&self) -> Result<LiveStatus, LiveError> {
        self.adapter.reconnect()
    }
}
#[async_trait::async_trait(?Send)]
impl AsyncLiveAdapter for WatchedAdapter {
    async fn snapshot_async(&self, c: Option<&LiveOperationContext>, r: Option<&LiveSnapshotRequest>) -> Result<LiveSnapshot, LiveError> {
        self.adapter.snapshot_async(c, r).await
    }
    async fn discover_async(&self, r: &LiveDiscoveryRequest, c: Option<&LiveOperationContext>) -> Result<LiveDiscoveryResult, LiveError> {
        self.adapter.discover_async(r, c).await
    }
    async fn get_async(&self, r: &LiveRef, c: Option<&LiveOperationContext>) -> Result<Option<Value>, LiveError> {
        self.adapter.get_async(r, c).await
    }
    async fn invoke_async(&self, i: &LiveInvocation, c: Option<&LiveOperationContext>) -> Result<Value, LiveError> {
        let changes = self.begin(&i.operation);
        let result = self.adapter.invoke_async(i, c).await;
        self.finish(changes, result)
    }
    async fn reconnect_async(&self, c: Option<&LiveOperationContext>) -> Result<LiveStatus, LiveError> {
        self.adapter.reconnect_async(c).await
    }
    async fn close(&self) -> Result<(), LiveError> {
        self.adapter.close().await
    }
    fn has_refresh_status_async(&self) -> bool {
        self.adapter.has_refresh_status_async()
    }
    async fn refresh_status_async(&self, c: Option<&LiveOperationContext>) -> Result<LiveStatus, LiveError> {
        self.adapter.refresh_status_async(c).await
    }
    fn has_subscribe_status(&self) -> bool {
        self.adapter.has_subscribe_status()
    }
    fn subscribe_status(&self, l: StatusListener) -> Unsubscribe {
        self.adapter.subscribe_status(l)
    }
    fn has_retire_transaction_async(&self) -> bool {
        self.adapter.has_retire_transaction_async()
    }
    async fn retire_transaction_async(&self, id: &str, c: Option<&LiveOperationContext>, terminal: bool) -> Result<Value, LiveError> {
        self.adapter.retire_transaction_async(id, c, terminal).await
    }
    fn retires_on_its_own(&self) -> bool {
        self.adapter.retires_on_its_own()
    }
    fn has_expect_state_digest(&self) -> bool {
        self.adapter.has_expect_state_digest()
    }
    fn expect_state_digest(&self, id: &str, i: &LiveInvocation) {
        self.adapter.expect_state_digest(id, i)
    }
}
impl McpHost {
    /// Apply the source host's shared undo refusal and no-dispatch state reconciliation.
    pub async fn with_undo_watch<F>(&self, id: &Value, params: &Value, execute: F) -> Result<Value, LiveError>
    where
        F: std::future::Future<Output = Result<Value, LiveError>>,
    {
        let transaction_id = params["transactionId"].as_str();
        if let Some(id) = transaction_id {
            self.undo_refusals.borrow_mut().remove(id);
        }
        let undoing = transaction_id.and_then(|id| self.transaction_record(id));
        let before = undoing.as_ref().and_then(|r| r.borrow().get("state").cloned());
        let watch = Rc::new(Cell::new(0));
        self.undo_watches.borrow_mut().push(watch.clone());
        struct WatchGuard<'a> {
            watches: &'a RefCell<Vec<Rc<Cell<usize>>>>,
            watch: Rc<Cell<usize>>,
        }
        impl Drop for WatchGuard<'_> {
            fn drop(&mut self) {
                self.watches.borrow_mut().retain(|w| !Rc::ptr_eq(w, &self.watch));
            }
        }
        let guard = WatchGuard { watches: &self.undo_watches, watch: watch.clone() };
        let result = execute.await;
        drop(guard);
        let result = result?;
        let refusal = transaction_id.and_then(|id| self.undo_refusals.borrow_mut().remove(id));
        if let Some(refusal) = refusal {
            if refusal.record.borrow()["state"] == "uncertain" {
                refusal.record.borrow_mut()["state"] = json!("applied");
                self.delete_undo_plan(&refusal.record);
                return Ok(reason_error(id, &format!("Undo refused before anything changed in Live: {}", adapter_reason(&refusal.message)), "Nothing changed in Live, and the change is still in place. Later changes may have moved or replaced what it made, so its undo can no longer be proven; change it by hand if needed."));
            }
        }
        let failed = (result["result"]["isError"] == true).then(|| result["result"]["content"][0]["text"].as_str()).flatten();
        let Some(record) = undoing else { return Ok(result) };
        if before.as_ref() != Some(&json!("applied")) || record.borrow()["state"] == "undone" || watch.get() > 0 || failed.is_none() {
            return Ok(result);
        }
        let refused = record.borrow()["state"] == "applied";
        {
            let mut record = record.borrow_mut();
            record["state"] = json!("applied");
            record.as_object_mut().unwrap().remove("undoKey");
        }
        self.delete_undo_plan(&record);
        if refused {
            return Ok(result);
        }
        let failed = failed.unwrap();
        let parsed = serde_json::from_str::<Value>(failed).ok();
        let reason = parsed.as_ref().and_then(|v| v["reason"].as_str()).unwrap_or(failed);
        Ok(reason_error(
            id,
            &format!("Undo stopped before it changed anything in Live: {reason}"),
            "Nothing changed in Live, and the change is still in place. A later undo checks it again from the start.",
        ))
    }
    fn delete_undo_plan(&self, record: &TransactionRecord) {
        self.undo_recovery_plans.borrow_mut().retain(|p| p.record.upgrade().is_some_and(|r| !Rc::ptr_eq(&r, record)));
    }
    pub(super) fn async_adapter(&self) -> Rc<dyn AsyncLiveAdapter> {
        let watches = self.undo_watches.borrow();
        if watches.is_empty() {
            self.adapter.clone()
        } else {
            Rc::new(WatchedAdapter { adapter: self.adapter.clone(), watches: watches.clone() })
        }
    }
    pub(super) fn begin_undo_recovery(&self, record: &TransactionRecord, key: &str) -> Result<(bool, Vec<Rc<RefCell<Value>>>), LiveError> {
        let reconciliation = record.borrow()["state"] == "uncertain";
        let mut plans = self.undo_recovery_plans.borrow_mut();
        plans.retain(|plan| plan.record.strong_count() > 0);
        let found = plans.iter().position(|plan| plan.record.upgrade().is_some_and(|r| Rc::ptr_eq(&r, record)));
        let index = if let Some(index) = found {
            if plans[index].key != key {
                return Err(LiveError::error("uncertain undo requires the exact original idempotency key"));
            }
            index
        } else {
            plans.push(RecoveryPlan {
                record: Rc::downgrade(record),
                key: key.into(),
                prior_state: record.borrow().get("state").cloned(),
                retried: false,
                steps: vec![],
            });
            plans.len() - 1
        };
        if reconciliation {
            plans[index].retried = true;
        }
        Ok((reconciliation, plans[index].steps.clone()))
    }
    pub(super) fn note_undo_refusal(&self, record: &TransactionRecord, cause: &LiveError, context: &LiveOperationContext) {
        if !matches!(cause, LiveError::MutationNotDispatched(_)) && !nothing_changed(cause) {
            return;
        }
        let plans = self.undo_recovery_plans.borrow();
        let Some(plan) = plans.iter().find(|plan| plan.record.upgrade().is_some_and(|r| Rc::ptr_eq(&r, record))) else { return };
        if plan.prior_state.as_ref() == Some(&json!("applied"))
            && !plan.retried
            && plan.steps.iter().all(|step| step.borrow()["completed"] != true)
        {
            if let Some(id) = &context.transaction_id {
                self.undo_refusals.borrow_mut().insert(id.clone(), UndoRefusal { record: record.clone(), message: cause.message().into() });
            }
        }
    }
    pub(super) async fn replay_undo_recovery(
        &self,
        record: &TransactionRecord,
        adapter: &dyn AsyncLiveAdapter,
        context: &LiveOperationContext,
    ) -> Result<(), LiveError> {
        let steps = self
            .undo_recovery_plans
            .borrow()
            .iter()
            .find(|plan| plan.record.upgrade().is_some_and(|r| Rc::ptr_eq(&r, record)))
            .map(|plan| plan.steps.clone())
            .unwrap_or_default();
        for step in steps {
            let row = step.borrow().clone();
            if row["completed"] != true {
                let result = adapter
                    .invoke_async(&LiveInvocation::new(row["operation"].as_str().unwrap(), row["args"].clone()), Some(context))
                    .await?;
                let mut row = step.borrow_mut();
                row["result"] = result;
                row["completed"] = json!(true);
            }
        }
        Ok(())
    }
    pub(super) async fn invoke_undo_recovery(
        &self,
        record: &TransactionRecord,
        adapter: &dyn AsyncLiveAdapter,
        operation: &str,
        args: &Value,
        context: &LiveOperationContext,
    ) -> Result<Value, LiveError> {
        let step = {
            let mut plans = self.undo_recovery_plans.borrow_mut();
            let plan = plans
                .iter_mut()
                .find(|plan| plan.record.upgrade().is_some_and(|r| Rc::ptr_eq(&r, record)))
                .ok_or_else(|| LiveError::error("undo recovery plan was not initialized"))?;
            let mut found = None;
            for candidate in &plan.steps {
                let row = candidate.borrow();
                if row["operation"] == operation && canonical_mutation_identity(&row["args"])? == canonical_mutation_identity(args)? {
                    found = Some(candidate.clone());
                    break;
                }
            }
            found.unwrap_or_else(|| {
                let step = Rc::new(RefCell::new(json!({"operation":operation,"args":args,"completed":false})));
                plan.steps.push(step.clone());
                step
            })
        };
        if step.borrow()["completed"] != true {
            let row = step.borrow().clone();
            let result =
                adapter.invoke_async(&LiveInvocation::new(row["operation"].as_str().unwrap(), row["args"].clone()), Some(context)).await;
            let result = match result {
                Ok(value) => value,
                Err(cause) => {
                    self.note_undo_refusal(record, &cause, context);
                    return Err(cause);
                }
            };
            let mut row = step.borrow_mut();
            row["result"] = result;
            row["completed"] = json!(true);
        }
        let result = step.borrow()["result"].clone();
        Ok(result)
    }
    pub(super) fn retain_bounded_transaction(
        &self,
        map: &BoundedTransactionMap,
        transaction: Value,
        kind: &str,
    ) -> Result<TransactionRecord, LiveError> {
        let now = kumi_common::time::now_ms_f64();
        for (key, candidate) in map.entries() {
            let candidate = candidate.borrow();
            if candidate["expiresAt"].as_f64().is_some_and(|expires| expires <= now)
                && !retention::RECOVERY_PROTECTED_STATES.contains(&candidate["state"].as_str().unwrap_or(""))
                && !retention::is_in_flight(&key)
            {
                map.delete(&key);
            }
        }
        let id = transaction["id"].as_str().ok_or_else(|| LiveError::error("transaction id is unavailable"))?.to_owned();
        map.insert(&id, transaction).map_err(|cause| {
            if cause.message().contains("capacity is exhausted") {
                LiveError::error(format!("{kind} transaction capacity is exhausted by in-flight work"))
            } else {
                cause
            }
        })
    }
    pub fn live_transaction_release(&self, id: &Value, params: &Value) -> Value {
        if !has_only(params, &["transactionIds"])
            || !params["transactionIds"]
                .as_array()
                .is_some_and(|items| (1..=64).contains(&items.len()) && items.iter().all(|v| is_non_empty_string(v, 128)))
        {
            return error(id, -32602, "transactionIds (1 to 64) are required", None);
        }
        let mut released = 0;
        let mut kept = vec![];
        for transaction_id in params["transactionIds"].as_array().unwrap() {
            let transaction_id = transaction_id.as_str().unwrap();
            if transaction_id.starts_with("batch_") {
                if !retention::is_in_flight(transaction_id) && self.batch_transactions.release(transaction_id) {
                    released += 1;
                } else {
                    kept.push(transaction_id);
                }
                continue;
            }
            let mut found = false;
            for map in [
                &self.audio_capture_transactions,
                &self.transactions,
                &self.arrangement_transactions,
                &self.session_structure_transactions,
                &self.device_parameter_transactions,
                &self.device_parameters_transactions,
                &self.audition_transactions,
                &self.transport_transactions,
                &self.clip_launch_transactions,
                &self.note_edit_transactions,
                &self.clip_lifecycle_transactions,
            ] {
                if let Some(record) = map.get(transaction_id) {
                    found = true;
                    if record.borrow()["state"] == "applied" && !retention::is_in_flight(transaction_id) {
                        map.delete(transaction_id);
                        released += 1;
                    } else {
                        kept.push(transaction_id);
                    }
                    break;
                }
            }
            if !found
                && (self.in_flight_mutations.borrow().contains_key(transaction_id)
                    || self.has_semantic_export(transaction_id)
                    || self.undo_refusals.borrow().contains_key(transaction_id)
                    || self.song_history_calls.borrow().iter().any(|(key, _)| key == transaction_id))
            {
                kept.push(transaction_id);
            }
        }
        let mut result = json!({"released":released});
        if !kept.is_empty() {
            result["kept"] = json!(kept);
        }
        success_text(id, &result)
    }
}

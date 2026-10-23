use crate::anchor::{self, CleanupResult, Event, OwnedAnchor};
use crate::diagnostic;
use crate::protocol::{
    now_ms, Arbitration, Authorization, Cleanup, Mode, Phase, ReceiptKind, StopReason, Timeline,
};
use std::io;

#[derive(Clone, Copy, Eq, PartialEq)]
enum Acceptance {
    Standalone,
    Generic,
    Handoff,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Ownership {
    Pending,
    Accepted(Acceptance),
    Uncertain,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Grant {
    Preparing,
    Awaiting,
    Sent,
    Unavailable,
}

#[derive(Clone, Copy)]
enum Stop {
    Requested(StopReason),
    Supervision,
    ChildExited(u8),
}

impl Stop {
    fn reason(self) -> StopReason {
        match self {
            Self::Requested(reason) => reason,
            Self::Supervision | Self::ChildExited(_) => StopReason::Failed,
        }
    }

    fn completion(self) -> Completion {
        let code = match self {
            Self::Requested(StopReason::Timedout) => 124,
            Self::Requested(_) => 125,
            Self::Supervision => 70,
            Self::ChildExited(code) => code,
        };
        Completion {
            code,
            reason: Some(self.reason()),
        }
    }
}

struct Completion {
    code: u8,
    reason: Option<StopReason>,
}

struct Supervisor {
    mode: Mode,
    anchor: OwnedAnchor,
    timeline: Timeline,
    ownership: Ownership,
    grant: Grant,
    stop: Option<Stop>,
    payload_exit: Option<u8>,
    channel_lost: bool,
    started_recorded: bool,
    diagnosed: bool,
}

pub fn run(mode: Mode, anchor: OwnedAnchor) -> u8 {
    let now = now_ms();
    let timeline = Timeline {
        phase: Phase::Shell,
        phase_at: now,
        deadline: now.saturating_add(mode.environment_ms()),
    };
    let mut supervisor = Supervisor {
        mode,
        anchor,
        timeline,
        ownership: Ownership::Pending,
        grant: Grant::Preparing,
        stop: None,
        payload_exit: None,
        channel_lost: false,
        started_recorded: false,
        diagnosed: false,
    };
    let completion = supervisor.drive();
    supervisor.finish(completion)
}

impl Supervisor {
    fn accepted(&self) -> bool {
        matches!(self.ownership, Ownership::Accepted(_))
    }

    fn fault(&mut self, error: &io::Error) {
        if !self.diagnosed {
            diagnostic(&format!(
                "supervision failed ({error}); reconciling ownership"
            ));
            self.diagnosed = true;
        }
        if !self.accepted() && self.stop.is_none() {
            self.stop = Some(Stop::Supervision);
        }
    }

    fn accept(&mut self, now: u64) {
        let acceptance = match &self.mode {
            Mode::Standalone => Acceptance::Standalone,
            Mode::Managed(_) if self.mode.is_handoff() => Acceptance::Handoff,
            Mode::Managed(_) => Acceptance::Generic,
        };
        self.ownership = Ownership::Accepted(acceptance);
        self.stop = None;
        self.timeline.phase = Phase::Transferred;
        self.timeline.phase_at = now;
    }

    fn publish(&mut self, kind: ReceiptKind) -> bool {
        match self.mode.publish(&self.timeline, kind) {
            Ok(()) => true,
            Err(error) => {
                self.fault(&error);
                false
            }
        }
    }

    fn observe_control(&mut self, now: u64) -> io::Result<()> {
        let Mode::Managed(attempt) = &self.mode else {
            return Ok(());
        };
        if let Some(reason) = attempt.stop_requested()? {
            self.stop = Some(Stop::Requested(reason));
            return Ok(());
        }
        match attempt.authorization()? {
            Authorization::Committed => {
                self.accept(now);
                return Ok(());
            }
            Authorization::Mismatch => {
                self.stop = Some(Stop::Requested(StopReason::Failed));
                return Ok(());
            }
            Authorization::Absent => {}
        }
        if !attempt.source_alive()? || !attempt.lease_alive(now)? {
            self.stop = Some(Stop::Requested(StopReason::SourceLost));
        }
        Ok(())
    }

    fn send_grant(&mut self) {
        if self.grant == Grant::Awaiting && self.payload_exit.is_none() {
            match self.anchor.grant() {
                Ok(()) => self.grant = Grant::Sent,
                Err(error) => {
                    self.grant = Grant::Unavailable;
                    self.fault(&error);
                }
            }
        }
    }

    fn drive(&mut self) -> Completion {
        loop {
            let now = now_ms();
            if !self.started_recorded {
                match self.mode.mark_started() {
                    Ok(()) => self.started_recorded = true,
                    Err(error) => self.fault(&error),
                }
            }
            if let Some(signal) = anchor::take_stop_signal() {
                let reason = if signal == libc::SIGINT {
                    StopReason::Cancelled
                } else {
                    StopReason::SourceLost
                };
                if self.ownership != Ownership::Accepted(Acceptance::Handoff) && self.stop.is_none()
                {
                    self.stop = Some(Stop::Requested(reason));
                }
            }
            if anchor::take_resize() {
                if let Err(error) = self.anchor.resize() {
                    self.fault(&error);
                }
            }
            if !self.accepted() && self.stop.is_none() {
                if let Err(error) = self.observe_control(now) {
                    self.fault(&error);
                }
            }
            if !self.accepted() && self.stop.is_none() && now >= self.timeline.deadline {
                self.stop = Some(Stop::Requested(StopReason::Timedout));
            }
            if let Some(stop) = self.stop {
                let decision = match self.ownership {
                    Ownership::Accepted(Acceptance::Handoff) => Arbitration::Accepted,
                    Ownership::Accepted(_) => match stop {
                        Stop::Requested(_) => Arbitration::Stopped,
                        Stop::Supervision | Stop::ChildExited(_) => Arbitration::Accepted,
                    },
                    Ownership::Pending | Ownership::Uncertain => self.mode.arbitrate_stop(),
                };
                match decision {
                    Arbitration::Accepted => self.accept(now),
                    Arbitration::Stopped => {
                        self.publish(ReceiptKind::Stopping {
                            reason: stop.reason(),
                        });
                        return stop.completion();
                    }
                    Arbitration::Uncertain => self.ownership = Ownership::Uncertain,
                }
            }
            if self.accepted() {
                if let Some(code) = self.payload_exit {
                    return Completion { code, reason: None };
                }
            }
            if self.stop.is_none() {
                if let Err(error) = self.anchor.start() {
                    self.fault(&error);
                }
                if self.grant == Grant::Awaiting && matches!(self.mode, Mode::Standalone) {
                    self.accept(now);
                }
                if self.accepted() {
                    self.send_grant();
                }
            }
            let kind = match self.ownership {
                Ownership::Accepted(_) => ReceiptKind::Transferred,
                Ownership::Uncertain => ReceiptKind::RecoveryRequired {
                    reason: self.stop.map(Stop::reason).unwrap_or(StopReason::Failed),
                },
                Ownership::Pending => match self.stop {
                    Some(stop) => ReceiptKind::Stopping {
                        reason: stop.reason(),
                    },
                    None => ReceiptKind::Active,
                },
            };
            if self.publish(kind) && self.stop.is_none() && self.mode.is_handoff() {
                self.send_grant();
            }
            match self.anchor.events() {
                Ok(events) => {
                    for event in events {
                        self.event(event, now_ms());
                    }
                }
                Err(error) => self.fault(&error),
            }
            if self.channel_lost
                && self.accepted()
                && self.payload_exit.is_none()
                && matches!(self.anchor.group_quiescent(), Ok(true))
            {
                self.payload_exit = Some(70);
            }
        }
    }

    fn event(&mut self, event: Event, now: u64) {
        match event {
            Event::Anchored => {
                if let Err(error) = self.anchor.acknowledge() {
                    self.fault(&error);
                }
            }
            Event::Environment => {
                if !self.accepted() {
                    self.timeline.phase = Phase::Environment;
                    self.timeline.phase_at = now;
                }
            }
            Event::Prepared => {
                if self.grant != Grant::Preparing {
                    self.fault(&io::Error::new(
                        io::ErrorKind::InvalidData,
                        "duplicate preparation event",
                    ));
                    return;
                }
                self.grant = Grant::Awaiting;
                if !self.accepted() {
                    self.timeline.phase = Phase::Startup;
                    self.timeline.phase_at = now;
                    self.timeline.deadline = now.saturating_add(self.mode.startup_ms());
                }
            }
            Event::Exited(code) => {
                self.payload_exit = Some(code);
                if !self.accepted() && self.stop.is_none() {
                    self.stop = Some(Stop::ChildExited(code));
                }
            }
            Event::Closed => {
                self.channel_lost = true;
                if self.payload_exit.is_none() {
                    self.fault(&io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "anchor event pipe closed",
                    ));
                }
            }
            Event::Invalid => {
                self.fault(&io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid anchor event",
                ));
            }
        }
    }

    fn finish(mut self, mut completion: Completion) -> u8 {
        let accepted = self.accepted();
        let kind = match self.anchor.cleanup() {
            CleanupResult::Confirmed => ReceiptKind::Exited {
                code: completion.code,
                reason: completion.reason,
                cleanup: Cleanup::Confirmed,
            },
            CleanupResult::Unknown => {
                diagnostic(
                    "owned group cleanup could not be confirmed; ownership recovery is required",
                );
                if !accepted {
                    completion.code = 70;
                }
                ReceiptKind::RecoveryRequired {
                    reason: completion.reason.unwrap_or(StopReason::Failed),
                }
            }
        };
        let result = if self.started_recorded {
            Ok(())
        } else {
            self.mode.mark_started()
        }
        .and_then(|()| self.mode.publish(&self.timeline, kind));
        if result.is_err() {
            diagnostic("could not record cleanup; ownership recovery is required");
        }
        completion.code
    }
}

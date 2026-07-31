//! `yantrad` — the Yantra control-plane daemon.
//!
//! An HTTP surface over [`yantra_core`], which holds the orchestration. The CLI
//! calls the same functions in-process and keeps working without this process
//! running at all ([ADR-0012]).
//!
//! It listens **only** on the addresses Tailscale says this machine holds, and
//! refuses to start when it cannot learn them. Q6 settled that Yantra is
//! personal-first, so there is no authentication — which makes the bind address
//! the entire security boundary (R-22), and makes an overridable one a mistake
//! waiting to be made. There is deliberately no flag for it.
//!
//! [ADR-0012]: ../../../docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md

use std::net::{IpAddr, SocketAddr};
use std::process::ExitCode;

use axum::Router;
use axum::routing::get;
use yantra_core::inventory::{Inventory, Tailscale};

const PORT: u16 = 7717;

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error("could not ask Tailscale which addresses this machine holds")]
    Tailnet(#[source] yantra_core::inventory::Error),

    #[error("this machine holds no Tailscale address, so there is nowhere safe to listen")]
    NoAddress,

    #[error("could not listen on {address}")]
    Bind {
        address: SocketAddr,
        #[source]
        source: std::io::Error,
    },

    #[error("the server stopped unexpectedly")]
    Serve(#[source] std::io::Error),
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "yantrad=info".into()),
        )
        .init();

    match serve(&Tailscale).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            report(&error);
            ExitCode::FAILURE
        }
    }
}

/// Walks the `source()` chain — the useful detail is usually a level down, and
/// a daemon that loses it leaves someone reading logs for the difference
/// between "Tailscale is not running" and "the port is taken".
fn report(error: &Error) {
    tracing::error!("{error}");
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        tracing::error!("  caused by: {cause}");
        source = cause.source();
    }
    if matches!(error, Error::Tailnet(_) | Error::NoAddress) {
        tracing::error!("  try: tailscale status");
    }
}

async fn serve<I: Inventory>(inventory: &I) -> Result<(), Error> {
    let addresses = listen_on(inventory).await?;
    let app = Router::new().route("/healthz", get(|| async { "ok" }));

    let mut servers = tokio::task::JoinSet::new();
    for address in addresses {
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(|source| Error::Bind { address, source })?;
        tracing::info!("listening on http://{address}");
        let app = app.clone();
        servers.spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown())
                .await
        });
    }

    while let Some(finished) = servers.join_next().await {
        match finished {
            Ok(Ok(())) => {}
            Ok(Err(source)) => return Err(Error::Serve(source)),
            // A panicking listener must not leave the others serving silently.
            Err(_) => return Err(Error::NoAddress),
        }
    }
    Ok(())
}

/// Fails closed. Every branch that cannot prove an address belongs to this
/// machine returns an error rather than a default, because the only default
/// available is one that listens to the whole world.
async fn listen_on<I: Inventory>(inventory: &I) -> Result<Vec<SocketAddr>, Error> {
    let addresses: Vec<IpAddr> = inventory.addresses().await.map_err(Error::Tailnet)?;
    if addresses.is_empty() {
        return Err(Error::NoAddress);
    }
    Ok(addresses
        .into_iter()
        .map(|address| SocketAddr::new(address, PORT))
        .collect())
}

/// M7 runs this under a supervisor, and I-27 is a standing reminder about
/// processes nobody reaps.
async fn shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!("could not listen for SIGTERM: {error}"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => tracing::info!("interrupted, shutting down"),
        () = terminate => tracing::info!("terminated, shutting down"),
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets the daemon, where the same call would take it down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use yantra_core::inventory::Fake;

    #[tokio::test]
    async fn it_listens_on_every_address_this_machine_holds() {
        let inventory = Fake {
            addresses: vec![
                "100.64.0.1".parse().expect("v4"),
                "fd7a:115c:a1e0::1".parse().expect("v6"),
            ],
            ..Fake::default()
        };
        let bound = listen_on(&inventory).await.expect("addresses are usable");
        assert_eq!(
            bound.iter().map(SocketAddr::to_string).collect::<Vec<_>>(),
            ["100.64.0.1:7717", "[fd7a:115c:a1e0::1]:7717"]
        );
    }

    /// R-22's retire condition, and the reason it is phrased as a refusal: a
    /// test that asserts the daemon *binds* passes just as well when the
    /// fallback is `0.0.0.0`.
    #[tokio::test]
    async fn it_refuses_to_start_when_this_machine_holds_no_address() {
        let refusal = listen_on(&Fake::default()).await;
        assert!(matches!(refusal, Err(Error::NoAddress)));
    }

    #[tokio::test]
    async fn a_tailnet_that_cannot_be_asked_is_a_refusal_and_not_a_default() {
        struct Down;
        impl Inventory for Down {
            async fn machines(
                &self,
            ) -> Result<Vec<yantra_core::inventory::MachineInfo>, yantra_core::inventory::Error>
            {
                unreachable!("the daemon only asks for addresses")
            }
            async fn addresses(&self) -> Result<Vec<IpAddr>, yantra_core::inventory::Error> {
                Err(yantra_core::inventory::Error::Command {
                    stderr: "failed to connect to local tailscaled".into(),
                })
            }
        }
        assert!(matches!(listen_on(&Down).await, Err(Error::Tailnet(_))));
    }

    /// Nothing listens on a well-known port by accident, and nothing routes
    /// off-tailnet: 7717 is fixed here and settable nowhere.
    #[test]
    fn the_port_is_a_constant_not_configuration() {
        assert_eq!(PORT, 7717);
    }
}

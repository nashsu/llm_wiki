use crate::{WebsocketConnection, WebsocketConnectionType, WebsocketExtension};
use glib::{prelude::*, translate::*};

mod sealed {
    pub trait Sealed {}
    impl<T: glib::IsA<crate::WebsocketConnection>> Sealed for T {}
}

pub trait WebsocketConnectionExtManual:
    IsA<WebsocketConnection> + sealed::Sealed + 'static
{
    #[doc(alias = "soup_websocket_connection_new")]
    fn new(
        stream: &impl IsA<gio::IOStream>,
        uri: &glib::Uri,
        type_: WebsocketConnectionType,
        origin: Option<&str>,
        protocol: Option<&str>,
        extensions: &[WebsocketExtension],
    ) -> WebsocketConnection {
        assert_initialized_main_thread!();
        unsafe {
            from_glib_full(ffi::soup_websocket_connection_new(
                stream.as_ref().to_glib_none().0,
                uri.to_glib_none().0,
                type_.into_glib(),
                origin.to_glib_none().0,
                protocol.to_glib_none().0,
                extensions.to_glib_full(),
            ))
        }
    }
}

impl<O: IsA<WebsocketConnection>> WebsocketConnectionExtManual for O {}

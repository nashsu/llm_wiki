use crate::{Message, Session, WebsocketConnection};
use glib::object::IsA;
use glib::translate::*;
use std::boxed::Box as Box_;
use std::pin::Pin;
use std::ptr;

mod sealed {
    pub trait Sealed {}
    impl<T: glib::IsA<crate::Session>> Sealed for T {}
}

pub trait SessionExtManual: IsA<Session> + sealed::Sealed + 'static {
    #[doc(alias = "soup_session_websocket_connect_async")]
    fn websocket_connect_async<P: FnOnce(Result<WebsocketConnection, glib::Error>) + 'static>(
        &self,
        msg: &Message,
        origin: Option<&str>,
        protocols: &[&str],
        io_priority: glib::Priority,
        cancellable: Option<&impl IsA<gio::Cancellable>>,
        callback: P,
    ) {
        let main_context = glib::MainContext::ref_thread_default();
        let is_main_context_owner = main_context.is_owner();
        let has_acquired_main_context = (!is_main_context_owner)
            .then(|| main_context.acquire().ok())
            .flatten();
        assert!(
            is_main_context_owner || has_acquired_main_context.is_some(),
            "Async operations only allowed if the thread is owning the MainContext"
        );

        let user_data: Box_<glib::thread_guard::ThreadGuard<P>> =
            Box_::new(glib::thread_guard::ThreadGuard::new(callback));
        unsafe extern "C" fn websocket_connect_async_trampoline<
            P: FnOnce(Result<WebsocketConnection, glib::Error>) + 'static,
        >(
            _source_object: *mut glib::gobject_ffi::GObject,
            res: *mut gio::ffi::GAsyncResult,
            user_data: glib::ffi::gpointer,
        ) {
            let mut error = ptr::null_mut();
            let ret = ffi::soup_session_websocket_connect_finish(
                _source_object as *mut _,
                res,
                &mut error,
            );
            let result = if error.is_null() {
                Ok(from_glib_full(ret))
            } else {
                Err(from_glib_full(error))
            };
            let callback: Box_<glib::thread_guard::ThreadGuard<P>> =
                Box_::from_raw(user_data as *mut _);
            let callback = callback.into_inner();
            callback(result);
        }
        let callback = websocket_connect_async_trampoline::<P>;
        unsafe {
            ffi::soup_session_websocket_connect_async(
                self.as_ref().to_glib_none().0,
                msg.to_glib_none().0,
                origin.to_glib_none().0,
                protocols.to_glib_none().0,
                io_priority.into_glib(),
                cancellable.map(|p| p.as_ref()).to_glib_none().0,
                Some(callback),
                Box_::into_raw(user_data) as *mut _,
            );
        }
    }

    fn websocket_connect_async_future(
        &self,
        msg: &Message,
        origin: Option<&str>,
        protocols: &[&str],
        io_priority: glib::Priority,
    ) -> Pin<
        Box_<dyn std::future::Future<Output = Result<WebsocketConnection, glib::Error>> + 'static>,
    > {
        let msg = msg.clone();
        let origin = origin.map(ToOwned::to_owned);
        let protocols = protocols
            .iter()
            .copied()
            .map(String::from)
            .collect::<Vec<_>>();
        Box_::pin(gio::GioFuture::new(self, move |obj, cancellable, send| {
            let protocols = protocols.iter().map(|s| s.as_str()).collect::<Vec<_>>();
            obj.websocket_connect_async(
                &msg,
                origin.as_ref().map(::std::borrow::Borrow::borrow),
                &protocols,
                io_priority,
                Some(cancellable),
                move |res| {
                    send.resolve(res);
                },
            );
        }))
    }
}

impl<O: IsA<Session>> SessionExtManual for O {}

use crate::{Server, ServerMessage, WebsocketConnection};
use glib::object::IsA;
use glib::translate::*;
use std::boxed::Box as Box_;
use std::collections::HashMap;

mod sealed {
    pub trait Sealed {}
    impl<T: glib::IsA<crate::Server>> Sealed for T {}
}

pub trait ServerExtManual: IsA<Server> + sealed::Sealed + 'static {
    #[doc(alias = "soup_server_add_early_handler")]
    fn add_early_handler<P: Fn(&Server, &ServerMessage, &str, HashMap<&str, &str>) + 'static>(
        &self,
        path: Option<&str>,
        callback: P,
    ) {
        let callback_data: Box_<P> = Box_::new(callback);
        unsafe extern "C" fn callback_func<
            P: Fn(&Server, &ServerMessage, &str, HashMap<&str, &str>) + 'static,
        >(
            server: *mut ffi::SoupServer,
            msg: *mut ffi::SoupServerMessage,
            path: *const libc::c_char,
            query: *mut glib::ffi::GHashTable,
            user_data: glib::ffi::gpointer,
        ) {
            let server = from_glib_borrow(server);
            let msg: Borrowed<ServerMessage> = from_glib_borrow(msg);
            let path: Borrowed<glib::GString> = from_glib_borrow(path);
            let query_map = query_map_from_hash_table(query);
            let callback: &P = &*(user_data as *mut _);
            (*callback)(&server, &msg, path.as_str(), query_map);
        }
        let callback = Some(callback_func::<P> as _);
        unsafe extern "C" fn destroy_func<
            P: Fn(&Server, &ServerMessage, &str, HashMap<&str, &str>) + 'static,
        >(
            data: glib::ffi::gpointer,
        ) {
            let _callback: Box_<P> = Box_::from_raw(data as *mut _);
        }
        let destroy_call6 = Some(destroy_func::<P> as _);
        let super_callback0: Box_<P> = callback_data;
        unsafe {
            ffi::soup_server_add_early_handler(
                self.as_ref().to_glib_none().0,
                path.to_glib_none().0,
                callback,
                Box_::into_raw(super_callback0) as *mut _,
                destroy_call6,
            );
        }
    }

    #[doc(alias = "soup_server_add_handler")]
    fn add_handler<P: Fn(&Server, &ServerMessage, &str, HashMap<&str, &str>) + 'static>(
        &self,
        path: Option<&str>,
        callback: P,
    ) {
        let callback_data: Box_<P> = Box_::new(callback);
        unsafe extern "C" fn callback_func<
            P: Fn(&Server, &ServerMessage, &str, HashMap<&str, &str>) + 'static,
        >(
            server: *mut ffi::SoupServer,
            msg: *mut ffi::SoupServerMessage,
            path: *const libc::c_char,
            query: *mut glib::ffi::GHashTable,
            user_data: glib::ffi::gpointer,
        ) {
            let server = from_glib_borrow(server);
            let msg: Borrowed<ServerMessage> = from_glib_borrow(msg);
            let path: Borrowed<glib::GString> = from_glib_borrow(path);
            let query_map = query_map_from_hash_table(query);
            let callback: &P = &*(user_data as *mut _);
            (*callback)(&server, &msg, path.as_str(), query_map);
        }
        let callback = Some(callback_func::<P> as _);
        unsafe extern "C" fn destroy_func<
            P: Fn(&Server, &ServerMessage, &str, HashMap<&str, &str>) + 'static,
        >(
            data: glib::ffi::gpointer,
        ) {
            let _callback: Box_<P> = Box_::from_raw(data as *mut _);
        }
        let destroy_call6 = Some(destroy_func::<P> as _);
        let super_callback0: Box_<P> = callback_data;
        unsafe {
            ffi::soup_server_add_handler(
                self.as_ref().to_glib_none().0,
                path.to_glib_none().0,
                callback,
                Box_::into_raw(super_callback0) as *mut _,
                destroy_call6,
            );
        }
    }

    #[doc(alias = "soup_server_add_websocket_handler")]
    fn add_websocket_handler<
        P: Fn(&Server, &ServerMessage, &str, &WebsocketConnection) + 'static,
    >(
        &self,
        path: Option<&str>,
        origin: Option<&str>,
        protocols: &[&str],
        callback: P,
    ) {
        let callback_data: Box_<P> = Box_::new(callback);
        unsafe extern "C" fn callback_func<
            P: Fn(&Server, &ServerMessage, &str, &WebsocketConnection) + 'static,
        >(
            server: *mut ffi::SoupServer,
            msg: *mut ffi::SoupServerMessage,
            path: *const libc::c_char,
            connection: *mut ffi::SoupWebsocketConnection,
            user_data: glib::ffi::gpointer,
        ) {
            let server = from_glib_borrow(server);
            let msg: Borrowed<ServerMessage> = from_glib_borrow(msg);
            let path: Borrowed<glib::GString> = from_glib_borrow(path);
            let connection = from_glib_borrow(connection);
            let callback: &P = &*(user_data as *mut _);
            (*callback)(&server, &msg, path.as_str(), &connection);
        }
        let callback = Some(callback_func::<P> as _);
        unsafe extern "C" fn destroy_func<
            P: Fn(&Server, &ServerMessage, &str, &WebsocketConnection) + 'static,
        >(
            data: glib::ffi::gpointer,
        ) {
            let _callback: Box_<P> = Box_::from_raw(data as *mut _);
        }
        let destroy_call6 = Some(destroy_func::<P> as _);
        let super_callback0: Box_<P> = callback_data;
        unsafe {
            ffi::soup_server_add_websocket_handler(
                self.as_ref().to_glib_none().0,
                path.to_glib_none().0,
                origin.to_glib_none().0,
                protocols.to_glib_none().0,
                callback,
                Box_::into_raw(super_callback0) as *mut _,
                destroy_call6,
            );
        }
    }
}

impl<O: IsA<Server>> ServerExtManual for O {}

unsafe fn query_map_from_hash_table<'a>(
    query: *mut glib::ffi::GHashTable,
) -> HashMap<&'a str, &'a str> {
    unsafe extern "C" fn read_query_hash_table(
        key: glib::ffi::gpointer,
        value: glib::ffi::gpointer,
        hash_map: glib::ffi::gpointer,
    ) {
        let key = glib::GStr::from_ptr_checked(key as *const libc::c_char);
        let value = glib::GStr::from_ptr_checked(value as *const libc::c_char);
        let hash_map: &mut HashMap<&str, &str> = &mut *(hash_map as *mut HashMap<&str, &str>);
        if let (Some(k), Some(v)) = (key, value) {
            hash_map.insert(k.as_str(), v.as_str());
        }
    }
    unsafe {
        let mut query_map = HashMap::with_capacity(glib::ffi::g_hash_table_size(query) as usize);
        glib::ffi::g_hash_table_foreach(
            query,
            Some(read_query_hash_table),
            &mut query_map as *mut HashMap<&str, &str> as *mut _,
        );
        query_map
    }
}

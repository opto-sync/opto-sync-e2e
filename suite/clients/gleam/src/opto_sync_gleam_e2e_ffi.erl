-module(opto_sync_gleam_e2e_ffi).
-export([request/3, unique_id/0]).

request(MethodBinary, PathBinary, Body) ->
    {ok, _} = application:ensure_all_started(inets),
    Base = case os:getenv("OPTO_SYNC_SERVER_URL") of
        false -> "http://localhost:3003";
        Value -> string:trim(Value, trailing, "/")
    end,
    Url = Base ++ binary_to_list(PathBinary),
    Method = case MethodBinary of
        <<"GET">> -> get;
        <<"POST">> -> post
    end,
    Request = case Method of
        get -> {Url, []};
        post -> {Url, [{"content-type", "application/json"}],
                 "application/json", Body}
    end,
    case httpc:request(
        Method,
        Request,
        [{timeout, 10000}, {connect_timeout, 5000}],
        [{body_format, binary}]
    ) of
        {ok, {{_Version, Status, _Reason}, _Headers, ResponseBody}} ->
            {ok, {Status, ResponseBody}};
        {error, _Reason} ->
            {error, nil}
    end.

unique_id() ->
    Time = integer_to_binary(erlang:system_time(microsecond)),
    Unique = integer_to_binary(erlang:unique_integer([positive, monotonic])),
    <<Time/binary, "-", Unique/binary>>.
